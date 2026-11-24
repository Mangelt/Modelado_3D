# Guía de Aplicación Móvil y Despliegue en la Nube

Esta guía detalla cómo compilar la **aplicación móvil Android (Capacitor)**, cómo instalar la **PWA**, cómo desplegar el **frontend en Vercel / Firebase Hosting** y cómo mantener la **sincronización bidireccional en tiempo real** entre la versión de escritorio y la aplicación móvil.

---

## 1. Arquitectura de Sincronización en Tiempo Real

El sistema utiliza un **Gateway WebSocket + Event Store + Bloqueos Distribuidos en MongoDB**:

```
 ┌────────────────────────────────────────────────────────┐
 │            Servidor Backend (Node.js + WS)             │
 │          Event Sourcing + MongoDB Replica Set          │
 └───────────────────────────┬────────────────────────────┘
                             │
             ▲               │               ▲
   WebSocket │ Eventos       │ Eventos       │ WebSocket
   Bidirecc. │ Real-Time     │ Real-Time     │ Bidirecc.
             ▼               │               ▼
 ┌────────────────────────┐  │  ┌────────────────────────┐
 │   Cliente Escritorio   │  │  │    Aplicación Móvil    │
 │ (Navegador PC / Web)   │  │  │  (Android / PWA Móvil) │
 └────────────────────────┘  ▼  └────────────────────────┘
                   Misma Sala ("equipo-1")
```

Cualquier cambio realizado en la computadora (`APLICAR_DELTA`, `CREAR_CUBO`, `SOLICITAR_BLOQUEO`, etc.) se difunde inmediatamente al socket de la aplicación móvil y viceversa, manteniendo ambas vistas sincronizadas en menos de 50 ms.

---

## 2. Aplicación Móvil (Capacitor Android)

El proyecto ya cuenta con el soporte móvil nativo configurado mediante **Capacitor 6** y una interfaz adaptada para pantallas táctiles con paneles laterales colapsables (*drawers*).

### A. Estructura Móvil Creada
- `android/`: Proyecto nativo completo de Android Studio con Gradle wrapper.
- `capacitor.config.json`: Configuración de Capacitor con soporte de tráfico en red local (`cleartext: true`).
- `client/manifest.json`: Web App Manifest para instalación como PWA en Android e iOS.
- Controles móviles en la interfaz:
  - Botón `☰ Objetos`: Despliega el panel de objetos y registro de actividad sobre la escena 3D.
  - Botón `⚙ Propiedades`: Despliega las transformaciones, color y edición geométrica.
  - Botón `⚙ Red`: Permite ingresar la IP del servidor de desarrollo o la URL del backend en producción.
  - Toque en la escena 3D cierra automáticamente los paneles para trabajar libremente.

### B. Comandos para la Aplicación Móvil

1. **Sincronizar cambios web con el proyecto Android**:
   ```bash
   npm run cap:sync
   ```

2. **Abrir el proyecto en Android Studio**:
   ```bash
   npm run cap:open:android
   ```
   *Desde Android Studio puedes conectar tu teléfono por USB o iniciar un emulador y pulsar "Run" (Play).*

3. **Compilar el APK de depuración directamente por consola**:
   *(Requiere Android SDK / ANDROID_HOME configurado en tu equipo)*
   ```bash
   npm run cap:build:apk
   ```
   El archivo `.apk` se generará en:
   `android/app/build/outputs/apk/debug/app-debug.apk`

---

## 3. Pruebas Locales (Escritorio ↔ Móvil en la Misma Red)

Para probar la sincronización entre tu PC y tu teléfono físico en tu casa/universidad:

1. **Obtén la IP local de tu computadora**:
   ```bash
   hostname -I | awk '{print $1}'
   # Ejemplo: 192.168.1.50
   ```

2. **Inicia el servidor backend**:
   ```bash
   cd server
   npm start
   ```

3. **Conectar el cliente de escritorio**:
   Abre en el navegador de tu computadora: `http://localhost:5500` (o el puerto configurado).

4. **Conectar la aplicación móvil**:
   * En la app móvil (o abriendo la IP desde el navegador de tu teléfono `http://192.168.1.50:5500`), pulsa el botón **⚙ Red** en la barra superior o en la pantalla de inicio de sesión.
   * Ingresa: `http://192.168.1.50:8080` (sustituyendo por tu IP real).
   * Pulsa **Guardar y Reconectar**.
   * Inicia sesión con usuarios distintos en la PC y en el móvil, entra a la misma sala (`equipo-1`) y verás los cubos moverse y sincronizarse en tiempo real.

---

## 4. Despliegue en la Nube (Vercel, Firebase y Backend)

> [!IMPORTANT]
> **Diferencia entre Frontend y Backend**:
> - **Vercel** y **Firebase Hosting** son plataformas excelentes para servir el **frontend estático** (`HTML + JS + Three.js + PWA`).
> - El **backend de este proyecto** mantiene conexiones WebSocket persistentes y Change Streams activos contra MongoDB. Los entornos *Serverless* tradicionales de Vercel/Firebase Functions tienen tiempos de corte (timeouts de 10 a 60 segundos) que desconectarían los WebSockets.
> - Por tanto, la arquitectura recomendada en la nube es:
>   - **Frontend**: Alojado en **Vercel** o **Firebase Hosting**.
>   - **Backend**: Alojado en un servicio de contenedores continuos gratuito/económico como **Render**, **Railway**, **Fly.io** o **Google Cloud Run** (con WebSockets habilitados).
>   - **Base de Datos**: **MongoDB Atlas** (clúster gratuito M0 con Replica Set habilitado de fábrica).

### Despliegue del Frontend en Vercel
El repositorio ya incluye `vercel.json` y `client/vercel.json`:
1. Sube tu proyecto a GitHub / GitLab.
2. En [vercel.com](https://vercel.com), pulsa **Add New Project**.
3. Selecciona tu repositorio. Si configuras "Root Directory", puedes dejar `.` o `client`.
4. Pulsa **Deploy**.
5. Obtendrás un dominio como: `https://tu-proyecto.vercel.app`.

### Despliegue del Frontend en Firebase Hosting
El repositorio ya incluye `firebase.json`:
1. Instala Firebase CLI si no lo tienes: `npm install -g firebase-tools`
2. Inicia sesión: `firebase login`
3. Inicializa el proyecto: `firebase init hosting` (selecciona usar el directorio existente `client`).
4. Despliega:
   ```bash
   firebase deploy --only hosting
   ```

### Conectar el Frontend en la Nube con el Backend
1. En tu backend desplegado (por ejemplo en Railway o Render: `https://mi-backend.up.railway.app`), configura la variable de entorno:
   ```bash
   CLIENT_ORIGINS=https://tu-proyecto.vercel.app,capacitor://localhost,http://localhost
   MONGO_URI=mongodb+srv://usuario:password@cluster.mongodb.net/sistemas_distribuidos_3d?retryWrites=true&w=majority
   AUTH_SECRET=secreto_seguro_de_32_caracteres_o_mas
   PORT=8080
   ```
2. En la app móvil o el cliente de Vercel, en la pantalla de acceso o en el botón **⚙ Red**, ingresa la URL de tu backend (`https://mi-backend.up.railway.app`). ¡Listo! Todo sincronizará en tiempo real sin importar la ubicación geográfica de los usuarios.
