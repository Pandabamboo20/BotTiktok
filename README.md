# 🎵 TikTok Music Bot

Bot de song requests para TikTok Live. Lee el chat en tiempo real y gestiona la cola de canciones.

---

## ⚡ Instalación local (para probar)

### Paso 1 — Instalar Node.js
Descargá Node.js desde https://nodejs.org (versión LTS)
Verificá que funcione abriendo la terminal y escribiendo:
```
node --version
```

### Paso 2 — Descargar este proyecto
Descomprimí la carpeta del bot donde quieras.

### Paso 3 — Instalar dependencias
Abrí la terminal dentro de la carpeta del proyecto y ejecutá:
```
npm install
```

### Paso 4 — Iniciar el servidor
```
npm start
```

### Paso 5 — Abrir en el navegador
Abrí http://localhost:3000
Ingresá el @usuario del streamer que esté en vivo → conectar.

---

## 🌐 Publicar en Railway (para acceso público)

### Paso 1 — Crear cuenta en GitHub
Andá a https://github.com y creá una cuenta gratis.

### Paso 2 — Subir el proyecto a GitHub
1. Andá a https://github.com/new
2. Nombre del repo: `tiktok-music-bot`
3. Privado ✓ → Crear repositorio
4. Subí todos los archivos de esta carpeta

### Paso 3 — Crear cuenta en Railway
Andá a https://railway.app y hacé login con tu cuenta de GitHub.

### Paso 4 — Crear nuevo proyecto
1. Hacé click en "New Project"
2. Elegí "Deploy from GitHub repo"
3. Seleccioná `tiktok-music-bot`
4. Railway va a detectar el `package.json` automáticamente

### Paso 5 — Obtener la URL pública
1. Una vez deployado, andá a Settings → Networking
2. Hacé click en "Generate Domain"
3. Te va a dar una URL tipo: `https://tiktok-music-bot-production.up.railway.app`

### Paso 6 — Compartir la URL
Cualquiera puede abrir esa URL, ingresar el @usuario del streamer
y usar el bot. No necesitan instalar nada.

---

## 💬 Comandos del chat (para los viewers)

| Comando | Descripción |
|---------|-------------|
| `!sr [canción]` | Pedir una canción |
| `!songrequest [canción]` | Igual que !sr |
| `!pedir [canción]` | Versión en español |
| `!skip` | Saltar canción (mod) |
| `!queue` o `!cola` | Ver la cola |
| `!np` | Ver qué suena ahora |

---

## 🔧 Notas importantes

- El streamer debe estar **en vivo** en TikTok para que funcione la conexión
- Si el live es privado o tiene restricciones, puede fallar
- Esta librería usa el protocolo interno de TikTok (no oficial)
  Si TikTok actualiza algo, puede dejar de funcionar temporalmente
- El plan gratuito de Railway es suficiente para uso normal
