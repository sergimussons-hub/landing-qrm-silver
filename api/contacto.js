/**
 * Recibe el formulario de contacto y lo distribuye por correo:
 *   1. Al alias de Odoo  -> crea automáticamente un lead en el CRM
 *   2. A la dirección de aviso -> notificación inmediata
 *
 * Se envía con Resend desde el propio dominio, para que no lo filtren
 * los antispam corporativos.
 *
 * Variables de entorno (se configuran en Vercel):
 *   RESEND_API_KEY  clave de API de Resend
 *   AVISO_DESDE     remitente verificado, p. ej. "QRM Institute <web@qrminstitute.com>"
 *   AVISO_PARA      dirección de aviso, p. ej. sergi@qrminstitute.com
 *   ODOO_ALIAS      alias del CRM, p. ej. info@tuempresa.odoo.com
 */

const ORIGEN = 'QRM Silver Certificate (web)';

function escapar(txt = '') {
	return String(txt)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function construirMensaje({ nombre, empresa, email, telefono, mensaje, newsletter }) {
	const filas = [
		['Nombre', nombre],
		['Empresa', empresa || '—'],
		['Email', email],
		['Teléfono', telefono || '—'],
		['Newsletter', newsletter || 'No'],
	];

	const html = `
		<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#1c355e;max-width:600px">
			<h2 style="color:#1c355e;margin:0 0 4px">Nueva solicitud de información</h2>
			<p style="color:#8a94a6;margin:0 0 18px;font-size:14px">${ORIGEN}</p>
			<table style="border-collapse:collapse;width:100%;font-size:15px">
				${filas
					.map(
						([k, v]) =>
							`<tr>
								<td style="padding:8px 12px;border:1px solid #e5e8ee;background:#f5f7fa;font-weight:700;width:130px">${k}</td>
								<td style="padding:8px 12px;border:1px solid #e5e8ee">${escapar(v)}</td>
							</tr>`,
					)
					.join('')}
			</table>
			<h3 style="margin:22px 0 6px;font-size:16px">Mensaje</h3>
			<p style="white-space:pre-wrap;line-height:1.6">${escapar(mensaje || '—')}</p>
			<p style="margin-top:24px;font-size:13px;color:#8a94a6">
				Responde a este correo para contestar directamente a ${escapar(nombre)}.
			</p>
		</div>`;

	const texto = [
		'Nueva solicitud de información',
		ORIGEN,
		'',
		...filas.map(([k, v]) => `${k}: ${v}`),
		'',
		'Mensaje:',
		mensaje || '—',
	].join('\n');

	return { html, texto };
}

/**
 * Alta en la newsletter (lista "Newsletter" de Odoo) a través del formulario
 * que ya tiene la web principal, para no duplicar claves de Odoo aquí.
 * Si falla, la solicitud sigue adelante: la newsletter es un extra.
 */
async function altaNewsletter(nombre, email) {
	const datos = new URLSearchParams({
		action: 'qrmi_nl_subscribe',
		nombre,
		email,
		privacidad: '1',
		web: '',
		t: String(Math.floor(Date.now() / 1000) - 60),
	});
	const res = await fetch('https://qrminstitute.es/wp-admin/admin-ajax.php', {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: datos.toString(),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok || !json.success) throw new Error(`Newsletter ${res.status}`);
}

async function enviarCorreo({ desde, para, replyTo, asunto, html, texto }) {
	const res = await fetch('https://api.resend.com/emails', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			from: desde,
			to: [para],
			reply_to: replyTo,
			subject: asunto,
			html,
			text: texto,
		}),
	});

	if (!res.ok) {
		const detalle = await res.text().catch(() => '');
		throw new Error(`Resend ${res.status}: ${detalle.slice(0, 200)}`);
	}
	return res.json();
}

export default async function handler(req, res) {
	if (req.method !== 'POST') {
		return res.status(405).json({ ok: false, error: 'Método no permitido.' });
	}

	const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
	const { nombre, empresa, email, telefono, mensaje, _gotcha, newsletter } = body;
	const quiereNewsletter = newsletter === '1' || newsletter === true || newsletter === 'on';

	// Campo trampa: los robots lo rellenan, las personas no lo ven.
	if (_gotcha) return res.status(200).json({ ok: true });

	if (!nombre || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
		return res.status(400).json({ ok: false, error: 'Faltan el nombre o un email válido.' });
	}

	const desde = process.env.AVISO_DESDE;
	if (!process.env.RESEND_API_KEY || !desde) {
		console.error('Faltan RESEND_API_KEY o AVISO_DESDE.');
		return res.status(500).json({
			ok: false,
			error: 'El formulario no está configurado. Escríbenos a info@qrminstitute.com.',
		});
	}

	const datos = { nombre, empresa, email, telefono, mensaje, newsletter: quiereNewsletter ? 'Sí' : 'No' };
	const { html, texto } = construirMensaje(datos);
	const asunto = `Nueva solicitud · ${nombre}${empresa ? ` (${empresa})` : ''}`;

	// Se intentan las dos vías por separado: que falle una no debe tumbar la otra.
	const destinos = [
		{ nombre: 'CRM', para: process.env.ODOO_ALIAS },
		{ nombre: 'aviso', para: process.env.AVISO_PARA },
	].filter((d) => d.para);

	const [resultadosCorreo, resultadoNewsletter] = await Promise.all([
		Promise.allSettled(
			destinos.map((d) =>
				enviarCorreo({ desde, para: d.para, replyTo: email, asunto, html, texto }),
			),
		),
		quiereNewsletter
			? altaNewsletter(String(nombre).slice(0, 120), String(email).slice(0, 160)).then(
					() => null,
					(err) => err,
				)
			: Promise.resolve(null),
	]);
	if (resultadoNewsletter) console.error('Fallo en el alta de la newsletter:', resultadoNewsletter);
	const resultados = resultadosCorreo;

	resultados.forEach((r, i) => {
		if (r.status === 'rejected') console.error(`Fallo enviando a ${destinos[i].nombre}:`, r.reason);
	});

	const algunoOk = resultados.some((r) => r.status === 'fulfilled');

	if (!algunoOk) {
		return res.status(502).json({
			ok: false,
			error: 'No hemos podido registrar tu solicitud. Escríbenos a info@qrminstitute.com.',
		});
	}

	return res.status(200).json({ ok: true });
}
