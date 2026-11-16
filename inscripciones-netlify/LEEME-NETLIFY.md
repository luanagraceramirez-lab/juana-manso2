# Inscripciones Juana Manso – publicar en Netlify

No necesitás crear cuentas en otros servicios ni cargar variables: con GitHub + Netlify alcanza.

## Qué cambió respecto de tu proyecto
Netlify no puede ejecutar un servidor Express "prendido" ni guardar archivos en disco, así que:

| Antes | Ahora |
|---|---|
| `server.js` (Express) | `netlify/functions/api.js` (mismas rutas `/api/...`) |
| SQLite local (`inscripciones.db`) | **Netlify Blobs** (almacenamiento privado de Netlify; cada solicitud e inscripto es un registro) |
| Carpeta `uploads/` | **Netlify Blobs** (almacén privado "documentos") |
| Sesión del panel en memoria | Token firmado (funciona en serverless) |
| Usuario y contraseña en el código | Siguen por defecto (`admin` / `JuanaManso2026`); se pueden cambiar con `ADMIN_USER` y `ADMIN_PASS` |

`public/` (index, admin, estilos) quedó igual, salvo: el límite de archivos pasó de 5 MB a **2 MB** (Netlify limita lo que recibe una función) y el panel lleva `noindex`.

## 1. Subir el proyecto a GitHub
En VS Code: *Source Control → Initialize Repository → Commit → Publish to GitHub*.
Elegí repositorio **privado**. El `.gitignore` ya evita subir `node_modules`, `.env`, `*.db` y `uploads/`.

## 2. Publicar en Netlify
1. https://app.netlify.com → **Add new site → Import an existing project** → elegí tu repositorio.
2. Netlify lee `netlify.toml` solo; no hace falta cambiar nada. Deploy.
3. Listo: el panel queda en `tu-sitio.netlify.app/admin.html` (usuario `admin`, contraseña `JuanaManso2026`).

Alternativa sin GitHub: `npm i -g netlify-cli`, `netlify login`, `netlify deploy --prod`.
(Arrastrar la carpeta en "Netlify Drop" NO sirve: no ejecuta funciones.)

## 3. Dominio
- **Gratis:** en *Domain management* podés cambiar el nombre del sitio y queda `tu-nombre.netlify.app`.
- **Propio** (`.com`, `.com.ar`): comprálo en un registrador y agregalo en *Domain management → Add a domain*.

## Probar en tu PC
`npm install` y `npx netlify dev`. Abrí `http://localhost:8888`.

## Cosas a tener en cuenta
- Los emails de aprobado/rechazado se "simulan" (se ven en *Logs* de la función) hasta que cargues `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` y `MAIL_FROM` en Netlify.
- Los datos viven en Netlify Blobs, que no es una base SQL: está pensado para un volumen chico (cientos de inscripciones) como el de una escuela. Si dos personas envían el formulario en el mismo instante exacto podrían recibir el mismo número de solicitud (muy poco probable).
- La contraseña por defecto está escrita en `api.js`: con un repositorio privado no hay problema, y apenas puedas cambiala cargando `ADMIN_PASS` en Netlify. Esto guarda DNI y boletines de menores.
