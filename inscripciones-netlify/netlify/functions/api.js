/* =====================================================================
   API de Inscripciones – Escuela Técnica Juana Manso (versión Netlify)

   Esta versión NO necesita ninguna cuenta ni servicio externo:
   - Los datos (solicitudes e inscriptos) y los documentos (DNI, boletín)
     se guardan en Netlify Blobs, el almacenamiento privado que ya trae Netlify.
   - La sesión del panel es un token firmado (sirve en serverless).
   - Express corre dentro de una Netlify Function (serverless-http).
   ===================================================================== */
const express = require('express');
const crypto = require('crypto');
const multer = require('multer');
const nodemailer = require('nodemailer');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const serverless = require('serverless-http');
const { getStore, connectLambda } = require('@netlify/blobs');

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'JuanaManso2026'; // contraseña por defecto; se puede cambiar con la variable ADMIN_PASS en Netlify
const ESPECIALIDADES = ['Informatica', 'Electrónica', 'Mecanica', 'Administracion de Empresas'];

// Netlify limita lo que se puede enviar a una función (~6 MB en total, y la
// codificación lo agranda), por eso cada archivo puede pesar hasta 2 MB.
const MAX_ARCHIVO = 2 * 1024 * 1024;

/* ---------- "Base de datos" (Netlify Blobs) ----------
   Cada registro es un archivo JSON:
     solicitud/000001   -> una solicitud (con la lista de sus documentos)
     inscripto/000001   -> una inscripción aprobada (se guarda al aprobar)
   Los archivos subidos van en otro almacén: "documentos".                */
const datos = () => getStore('inscripciones');
const docsStore = () => getStore('documentos'); // privado: solo accesible desde la función

const clave = (tipo, id) => `${tipo}/${String(id).padStart(6, '0')}`;
const leer = (k) => datos().get(k, { type: 'json' });
const guardar = (k, v) => datos().setJSON(k, v);
async function todos(tipo) {
  const { blobs } = await datos().list({ prefix: tipo + '/' });
  const regs = await Promise.all(blobs.map(b => leer(b.key)));
  return regs.filter(Boolean);
}
const ahora = () => new Date().toLocaleString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' }); // 2026-11-16 14:30:00
const porNombre = (a, b) => `${a.apellido} ${a.nombre}`.localeCompare(`${b.apellido} ${b.nombre}`, 'es');

const LISTA = ['nombre','apellido','dni','fecha_nacimiento','email','telefono','domicilio',
  'especialidad','escuela_anterior','tutor_nombre','tutor_telefono'];

/* ---------- Subida de archivos (en memoria; se guardan en Netlify Blobs) ---------- */
const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'application/pdf': '.pdf' };
const subir = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ARCHIVO, files: 2 },
  fileFilter: (_r, f, cb) => cb(EXT[f.mimetype] ? null : new Error('Los archivos deben ser JPG, PNG o PDF.'), !!EXT[f.mimetype]),
}).fields([{ name: 'dni_foto', maxCount: 1 }, { name: 'boletin', maxCount: 1 }]);
const recibir = (req, res, next) => subir(req, res, err => {
  if (!err) return next();
  res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Cada archivo puede pesar hasta 2 MB.' : (err.message || 'No se pudo subir el archivo.') });
});
// Verifica que el contenido real sea JPG, PNG o PDF (no solo la extensión)
const FIRMAS = [[0xFF, 0xD8, 0xFF], [0x89, 0x50, 0x4E, 0x47], [0x25, 0x50, 0x44, 0x46]];
const firmaValida = f => FIRMAS.some(sig => sig.every((b, i) => f.buffer[i] === b));
const aArrayBuffer = b => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/* ---------- Email (si no hay SMTP configurado, se simula en los logs) ---------- */
const transporte = process.env.SMTP_HOST ? nodemailer.createTransport({
  host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_PORT === '465',
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
}) : null;

async function avisar(s, aprobada, motivo) {
  const asunto = aprobada ? 'Tu inscripción fue aprobada' : 'Tu inscripción no fue aprobada';
  const cuerpo = aprobada
    ? 'Tu solicitud de inscripción en la Escuela Técnica Juana Manso fue aprobada. La escuela se va a comunicar con vos para los próximos pasos.'
    : 'Tu solicitud de inscripción en la Escuela Técnica Juana Manso no pudo ser aprobada.' + (motivo ? '\nMotivo: ' + motivo : '') + '\nPodés acercarte a la escuela para consultar.';
  const texto = `Hola ${s.nombre}:\n\n${cuerpo}\n\nEscuela Técnica Juana Manso`;
  if (!transporte) { console.log(`\n[EMAIL SIMULADO] Para: ${s.email}\nAsunto: ${asunto}\n${texto}\n`); return 'simulado'; }
  try {
    await transporte.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: s.email, subject: asunto, text: texto });
    return 'enviado';
  } catch (e) { console.error('Error al enviar email:', e.message); return 'error'; }
}

/* ---------- Express ---------- */
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '50kb' }));

// Netlify puede entregar la ruta como /api/... o como /.netlify/functions/api/...
// Esto las deja siempre como /api/...
app.use((req, _res, next) => {
  req.url = req.url.replace(/^\/\.netlify\/functions\/api/, '');
  if (!req.url.startsWith('/api')) req.url = '/api' + req.url;
  next();
});

// Evita repetir try/catch en cada ruta: cualquier error termina en el manejador final
const ruta = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Lo que se le muestra al panel: la solicitud/inscripto con sus documentos (sin datos internos)
const conDocs = r => ({ ...r, documentos: (r.documentos || []).map(({ id, tipo, nombre_original }) => ({ id, tipo, nombre_original })) });

/* ---------- PÚBLICO ---------- */
app.get('/api/especialidades', (_req, res) => res.json(ESPECIALIDADES));

app.post('/api/inscripcion', recibir, ruta(async (req, res) => {
  const fallar = (codigo, error) => res.status(codigo).json({ error });
  const archivos = Object.values(req.files || {}).flat();
  const d = {};
  for (const c of LISTA) d[c] = String(req.body[c] ?? '').trim().slice(0, 150);

  const obligatorios = LISTA.filter(c => c !== 'escuela_anterior');
  if (obligatorios.some(c => !d[c])) return fallar(400, 'Completá todos los campos obligatorios.');
  if (!/^\d{7,8}$/.test(d.dni)) return fallar(400, 'El DNI debe tener 7 u 8 números, sin puntos.');
  if (!/^\S+@\S+\.\S+$/.test(d.email)) return fallar(400, 'El email no es válido.');
  if (!ESPECIALIDADES.includes(d.especialidad)) return fallar(400, 'Elegí una especialidad de la lista.');
  if (isNaN(Date.parse(d.fecha_nacimiento))) return fallar(400, 'La fecha de nacimiento no es válida.');

  if (!req.files?.dni_foto) return fallar(400, 'Subí la foto del DNI.');
  if (archivos.some(f => !firmaValida(f))) return fallar(400, 'Uno de los archivos no es una imagen JPG/PNG ni un PDF válido.');

  const existentes = await todos('solicitud');
  if (existentes.some(s => s.dni === d.dni && ['pendiente', 'aprobada'].includes(s.estado)))
    return fallar(409, 'Ya existe una inscripción con ese DNI.');

  // Guardar primero los archivos
  const documentos = [];
  for (const [tipo, [f]] of Object.entries(req.files)) {
    const id = crypto.randomBytes(16).toString('hex') + EXT[f.mimetype];
    await docsStore().set(id, aArrayBuffer(f.buffer));
    documentos.push({ id, tipo, nombre_original: f.originalname.slice(0, 120), mime: f.mimetype });
  }

  // Número de solicitud = el siguiente al más alto que exista
  const id = existentes.reduce((m, s) => Math.max(m, s.id), 0) + 1;
  await guardar(clave('solicitud', id), { id, ...d, estado: 'pendiente', motivo: null, creada_en: ahora(), evaluada_en: null, documentos });
  res.status(201).json({ ok: true, numero: id });
}));

/* ---------- ADMIN ---------- */
// Sesión sin memoria del servidor: el token lleva su vencimiento y una firma.
const claveSesion = () => crypto.createHash('sha256')
  .update('sesion|' + (process.env.SESSION_SECRET || ADMIN_PASS)).digest();
const firmar = texto => crypto.createHmac('sha256', claveSesion()).update(texto).digest('base64url');

function crearToken() {
  const cuerpo = Buffer.from(JSON.stringify({ exp: Date.now() + 2 * 60 * 60 * 1000 })).toString('base64url'); // 2 horas
  return cuerpo + '.' + firmar(cuerpo);
}
function tokenValido(token) {
  const [cuerpo, firma] = String(token || '').split('.');
  if (!cuerpo || !firma) return false;
  const a = Buffer.from(firma), b = Buffer.from(firmar(cuerpo));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(cuerpo, 'base64url').toString()).exp > Date.now(); }
  catch { return false; }
}

const iguales = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

app.post('/api/admin/login', ruta(async (req, res) => {
  const { usuario = '', clave = '' } = req.body || {};
  if (!(iguales(usuario, ADMIN_USER) && iguales(clave, ADMIN_PASS))) {
    await new Promise(r => setTimeout(r, 800)); // frena los intentos de adivinar la clave
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos.' });
  }
  res.json({ token: crearToken() });
}));

function auth(req, res, next) {
  if (!tokenValido((req.headers.authorization || '').replace('Bearer ', '')))
    return res.status(401).json({ error: 'Sesión vencida.' });
  next();
}

app.get('/api/admin/solicitudes', auth, ruta(async (req, res) => {
  const estado = ['pendiente','aprobada','rechazada'].includes(req.query.estado) ? req.query.estado : 'pendiente';
  const lista = (await todos('solicitud')).filter(s => s.estado === estado).sort((a, b) => b.id - a.id);
  res.json(lista.map(conDocs));
}));

app.get('/api/admin/inscriptos', auth, ruta(async (_req, res) => {
  res.json((await todos('inscripto')).sort(porNombre).map(conDocs));
}));

app.post('/api/admin/solicitudes/:id/aprobar', auth, ruta(async (req, res) => {
  const id = Number(req.params.id);
  const s = await leer(clave('solicitud', id));
  if (!s || s.estado !== 'pendiente') return res.status(404).json({ error: 'La solicitud no existe o ya fue evaluada.' });
  const fecha = ahora();
  // Primero se guarda el inscripto y después se marca la solicitud: si algo falla
  // en el medio, volver a aprobar simplemente repite el mismo paso.
  const { estado, motivo, creada_en, evaluada_en, ...campos } = s;
  await guardar(clave('inscripto', id), { ...campos, solicitud_id: id, aprobado_en: fecha });
  await guardar(clave('solicitud', id), { ...s, estado: 'aprobada', evaluada_en: fecha });
  res.json({ ok: true, mail: await avisar(s, true) });
}));

app.post('/api/admin/solicitudes/:id/rechazar', auth, ruta(async (req, res) => {
  const id = Number(req.params.id);
  const motivo = String((req.body || {}).motivo || '').trim().slice(0, 300);
  const s = await leer(clave('solicitud', id));
  if (!s || s.estado !== 'pendiente') return res.status(404).json({ error: 'La solicitud no existe o ya fue evaluada.' });
  await guardar(clave('solicitud', id), { ...s, estado: 'rechazada', motivo, evaluada_en: ahora() });
  res.json({ ok: true, mail: await avisar(s, false, motivo) });
}));

app.get('/api/admin/documentos/:id', auth, ruta(async (req, res) => {
  const docId = String(req.params.id);
  // Solo se entrega un archivo que pertenezca a una solicitud registrada
  const doc = (await todos('solicitud')).flatMap(s => s.documentos || []).find(x => x.id === docId);
  if (!doc) return res.status(404).json({ error: 'Documento no encontrado.' });
  const contenido = await docsStore().get(doc.id, { type: 'arrayBuffer' });
  if (!contenido) return res.status(404).json({ error: 'El archivo ya no está disponible.' });
  res.attachment(doc.nombre_original);
  res.type(doc.mime).send(Buffer.from(contenido));
}));

/* ---------- Exportar inscriptos ---------- */
const listaInscriptos = async () => (await todos('inscripto')).sort(porNombre);

app.get('/api/admin/exportar/inscriptos.xlsx', auth, ruta(async (_req, res) => {
  const columnas = [['apellido', 'Apellido', 18], ['nombre', 'Nombre', 18], ['dni', 'DNI', 12], ['fecha_nacimiento', 'Nacimiento', 13],
    ['especialidad', 'Especialidad', 22], ['email', 'Email', 28], ['telefono', 'Teléfono', 15], ['domicilio', 'Domicilio', 28],
    ['tutor_nombre', 'Tutor', 22], ['tutor_telefono', 'Tel. tutor', 15]];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Inscriptos');
  ws.columns = columnas.map(([key, header, width]) => ({ key, header, width }));
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  (await listaInscriptos()).forEach(f => ws.addRow(f));
  const buffer = await wb.xlsx.writeBuffer();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="inscriptos.xlsx"');
  res.send(Buffer.from(buffer));
}));

app.get('/api/admin/exportar/inscriptos.pdf', auth, ruta(async (_req, res) => {
  const cols = [['apellido', 'Apellido', 95], ['nombre', 'Nombre', 95], ['dni', 'DNI', 65], ['especialidad', 'Especialidad', 130],
    ['email', 'Email', 170], ['telefono', 'Teléfono', 80], ['tutor_nombre', 'Tutor', 130]];
  const inscriptos = await listaInscriptos();
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
  const partes = [];
  doc.on('data', p => partes.push(p));
  const terminado = new Promise((ok, mal) => { doc.on('end', ok); doc.on('error', mal); });

  const fila = (valores, y, negrita) => {
    doc.font(negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(9);
    let x = 30;
    cols.forEach(([, , ancho], i) => { doc.text(String(valores[i] ?? ''), x, y, { width: ancho - 6, height: 12, ellipsis: true }); x += ancho; });
  };
  const encabezado = y => { fila(cols.map(c => c[1]), y, true); return y + 18; };
  doc.font('Helvetica-Bold').fontSize(14).text('Escuela Técnica Juana Manso – Inscriptos', 30, 30);
  doc.font('Helvetica').fontSize(9).text('Generado el ' + new Date().toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }), 30, 50);
  let y = encabezado(75);
  for (const f of inscriptos) {
    if (y > 540) { doc.addPage(); y = encabezado(30); }
    fila(cols.map(c => f[c[0]]), y, false); y += 16;
  }
  doc.end();
  await terminado;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename="inscriptos.pdf"');
  res.send(Buffer.concat(partes));
}));

/* ---------- Errores: siempre responder JSON (el sitio espera JSON) ---------- */
app.use('/api', (_req, res) => res.status(404).json({ error: 'No encontrado.' }));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Error del servidor. Probá de nuevo en un momento.' });
});

/* ---------- Entrada de Netlify ---------- */
const manejador = serverless(app, {
  binary: ['application/pdf', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/*', 'application/octet-stream'],
});
exports.handler = async (event, context) => {
  connectLambda(event); // habilita Netlify Blobs en este tipo de función
  return manejador(event, context);
};
exports.app = app; // solo para pruebas
