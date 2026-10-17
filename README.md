# Law Analytics - Sistema de Scraping y Actualizaciones

Sistema para el scraping automático de tasas financieras, normativas legales y datos previsionales, con notificaciones por email y API REST.

## Características

- Scraping de tasas desde múltiples fuentes (BCRA, BNA, CPACF)
- Scraping de normativas legales desde Infoleg
- Actualización automática de categorías basadas en movilidad previsional
- Notificaciones por email sobre actualizaciones
- API REST para consulta de datos
- Panel de administración para gestión de tareas
- Sistema de tareas programadas configurables
- Registro detallado de actividades
- Análisis estadístico de datos y uso del sistema

## Requisitos previos

- Node.js 14.x o superior
- MongoDB 4.x o superior (compatible con Mongoose 8.11.0)
- AWS CLI configurado para acceso a SecretsManager y SES
- Credenciales de CPACF para acceso a tasas

## Instalación

1. Clonar el repositorio:
   ```bash
   git clone https://github.com/your-username/law-analytics.git
   cd law-analytics
   ```

2. Instalar dependencias:
   ```bash
   npm install
   ```

3. Configurar variables de entorno (o usar AWS SecretsManager):
   ```bash
   cp .env.example .env
   # Editar .env con los valores apropiados
   ```

4. Iniciar la aplicación:
   ```bash
   npm start
   ```

## Estructura del proyecto

```
server/
├── config/                  # Configuraciones (DB, AWS, etc.)
├── controllers/             # Controladores para las rutas
├── middlewares/             # Middlewares de Express
├── models/                  # Modelos de MongoDB
├── routes/                  # Rutas organizadas por dominio
├── services/                # Lógica de negocio
│   ├── scrapers/            # Servicios de scraping separados por fuente
│   ├── aws_ses/             # Servicios de email con AWS SES
│   ├── stats/               # Servicios de análisis estadístico
│   ├── file_manager/        # Gestión de archivos 
│   └── tasks/               # Tareas programadas
├── utils/                   # Utilidades generales
├── tests/                   # Tests unitarios y de integración
│   ├── unit/                # Tests unitarios
│   └── integration/         # Tests de integración
└── files/                   # Archivos temporales y de procesamiento
```

## Tareas programadas

La aplicación incluye varias tareas programadas que se ejecutan automáticamente. Cada tarea tiene asignado un identificador numérico (TaskNumber) para facilitar su gestión. Puedes usar este número en la API para ejecutar, detener o iniciar tareas, lo que simplifica la administración:

| N° | TaskID                          | Descripción                                          | Programación    |
|----|--------------------------------|------------------------------------------------------|-----------------|
| 1  | `bna-tasa-activa-bna`          | Actualiza tasa activa BNA                            | Diario 9:18 AM  |
| 2  | `búsqueda-fechas-activa-bna`   | Búsqueda de tasas activas BNA por fechas             | Diario 10:00 AM |
| 3  | `consejo-tasa-activa-bna`      | Scraping de tasa activa BNA desde CPACF              | Diario 11:58 AM |
| 4  | `bna-tasa-pasiva-bna`          | Descarga y procesa tasa pasiva BNA                   | Diario 9:20 AM  |
| 5  | `consejo-tasa-pasiva-bna`      | Scraping de tasa pasiva BNA desde CPACF              | Diario 11:59 AM |
| 6  | `búsqueda-fechas-pasiva-bna`   | Búsqueda de tasas pasivas BNA por fechas             | Diario 10:30 AM |
| 7  | `bcra-pasiva-bcra`             | Descarga y procesa tasa pasiva BCRA                  | Diario 9:00 AM  |
| 8  | `búsqueda-fechas-pasiva-bcra`  | Búsqueda de tasas pasivas BCRA por fechas            | Diario 10:15 AM |
| 9  | `bcra-cer-bcra`                | Descarga y procesa CER                               | Diario 9:05 AM  |
| 10 | `búsqueda-fechas-cer-bcra`     | Búsqueda de CER por fechas                           | Diario 10:20 AM |
| 11 | `bcra-icl-bcra`                | Descarga y procesa ICL                               | Diario 9:10 AM  |
| 12 | `búsqueda-fechas-icl-bcra`     | Búsqueda de ICL por fechas                           | Diario 10:25 AM |
| 13 | `busqueda-fechas-tasaActivaCNAT2658` | Scraping de tasa acta 2658 desde CPACF         | Diario 12:00 PM |
| 14 | `busqueda-fechas-tasaActivaCNAT2764` | Scraping de tasa acta 2764 desde CPACF         | Diario 12:01 PM |
| 15 | `busqueda-fechas-tasaActivaBNA`      | Búsqueda específica de tasa activa BNA         | Diario 12:05 PM |
| 16 | `busqueda-fechas-tasaActivaTnaBNA`   | Búsqueda de tasa activa TNA BNA                | Diario 12:10 PM |
| 17 | `busqueda-fechas-tasaPasivaBNA`      | Búsqueda de tasa pasiva BNA                    | Diario 12:15 PM |
| 18 | `eliminar-files`                     | Limpieza de archivos en server/files           | Diario 2:00 AM  |
| 19 | `sync-stats`                         | Sincronización de estadísticas                  | Diario 3:00 AM  |
| 20 | `analysis-stats`                     | Análisis de estadísticas                        | Diario 4:00 AM  |
| 21 | `verificacion-tasas-matutina`        | Reporte de tasas y datos previsionales (siempre) | Diario 9:00 AM  |
| 22 | `verificacion-tasas-ciclica`         | Mismo reporte, solo si falla alguna tasa        | 7:55, 9:55, 11:55, 13:55, 15:55, 21:55 |
| 23 | `verificacion-tasas-diaria`          | Reporte completo de tasas y datos previsionales (siempre) | Diario 11:00 PM |
| —  | `sync-datos-previsionales`           | Sincroniza `datosprevisionales` desde InfoLeg (ANSES, bonos, SMVM) | Diario 12:20 y 18:20 |
| —  | `audit-datos-previsionales`          | Auditoría de cobertura del mes próximo          | Último día del mes 22:00 |

> La numeración y los horarios de las filas 1–20 son históricos; la programación vigente está en
> `server/config/cronConfig.js` (zona horaria `America/Argentina/Buenos_Aires`).

### Datos previsionales

La colección `datosprevisionales` (un documento por mes con movilidad, haberes mínimo y máximo, bases imponibles, PBU,
PUAM, bono, salario mínimo y suplemento del 82 %) se mantiene al día leyendo de InfoLeg las resoluciones mensuales de
ANSES (vínculos de la ley 24.241 y del DNU 274/2024), los decretos de bono y las resoluciones del Consejo del Salario.
Solo completa meses y campos vacíos, deja todo auditado y revertible, y su estado (último mensual con datos, mes en curso,
pendientes, corridas del cron) va en el reporte diario por correo, cuyo asunto es
`[OK|AVISO|ALERTA] Tasas y datos previsionales <fecha> · …`.

Documentación completa: **[docs/DATOS_PREVISIONALES.md](docs/DATOS_PREVISIONALES.md)**.

### Gestión de archivos

Los archivos generados durante los procesos de scraping (capturas de pantalla, PDFs, HTMLs, etc.) se guardan automáticamente en la carpeta `server/files`. Esto incluye:

- Capturas de pantalla (`{prefix}-{timestamp}.png`)
- Archivos HTML (`{filename}.html`)
- Archivos de texto extraídos de PDFs (`{filename}_text.txt`)
- Archivos JSON de resultados (`tasas-para-mongo.json`, `tasas-diarias-para-mongo.json`, `resultados-interes.json`)

La tarea programada `eliminar-files` (N° 18) se encarga de limpiar periódicamente estos archivos para evitar la acumulación de datos innecesarios.


## API REST

La API incluye los siguientes endpoints:

### Tasas

- `GET /api/tasas/consulta` - Consulta tasas por rango de fechas y campo específico
  - Parámetros:
    - `fechaDesde` (obligatorio): Fecha inicial del rango (formatos aceptados: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, YYYY/MM/DD)
    - `fechaHasta` (obligatorio): Fecha final del rango (formatos aceptados: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, YYYY/MM/DD)
    - `campo` (obligatorio): Campo a consultar (tasaPasivaBNA, tasaPasivaBCRA, tasaActivaBNA, cer, icl, tasaActivaCNAT2601, tasaActivaCNAT2658, tasaActivaCNAT2764, tasaActivaTnaBNA)
    - `completo` (opcional): Booleano (true/false) que determina si se devuelve el rango completo o solo los extremos

- `GET /api/tasas/listado` - Obtiene listado de tasas disponibles
  - No requiere parámetros
  - Requiere autenticación

- `POST /api/tasas/update` - Actualiza información de tasas
  - Parámetros:
    - `tasaId` (obligatorio): ID de la tasa a actualizar
    - `fechaDesde` (obligatorio): Fecha inicial en formato YYYY-MM-DD
    - `fechaHasta` (obligatorio): Fecha final en formato YYYY-MM-DD
    - `tipoTasa` (obligatorio): Tipo de tasa a actualizar
  - Requiere autenticación de administrador

### Tareas programadas

- `GET /api/tasks` - Obtiene lista de tareas programadas
  - No requiere parámetros
  - Requiere autenticación de administrador

- `POST /api/tasks/:taskId/execute` - Ejecuta una tarea inmediatamente
  - Path params:
    - `taskId` (obligatorio): ID de la tarea a ejecutar o su número (1-23)
  - Requiere autenticación de administrador
  - Ejemplo: `POST /api/tasks/4/execute` ejecuta la tarea número 4 (bna-tasa-pasiva-bna)

- `POST /api/tasks/:taskId/stop` - Detiene una tarea
  - Path params:
    - `taskId` (obligatorio): ID de la tarea a detener o su número (1-23)
  - Requiere autenticación de administrador
  - Ejemplo: `POST /api/tasks/7/stop` detiene la tarea número 7 (bcra-pasiva-bcra)

- `POST /api/tasks/:taskId/start` - Inicia una tarea detenida
  - Path params:
    - `taskId` (obligatorio): ID de la tarea a iniciar o su número (1-23)
  - Requiere autenticación de administrador
  - Ejemplo: `POST /api/tasks/18/start` inicia la tarea número 18 (eliminar-files)

- `POST /api/tasks/initialize` - Inicializa todas las tareas
  - No requiere parámetros
  - Requiere autenticación de administrador

- `POST /api/tasks/stop-all` - Detiene todas las tareas
  - No requiere parámetros
  - Requiere autenticación de administrador

### Estadísticas

- `GET /api/stats/dashboard` - Obtiene estadísticas del dashboard
  - No requiere parámetros
  - Requiere autenticación

- `GET /api/stats/dashboard/:userId` - Obtiene estadísticas del dashboard para un usuario específico
  - Path params:
    - `userId` (obligatorio): ID del usuario
  - Requiere autenticación

- `GET /api/stats/analytics` - Obtiene análisis estadísticos generales
  - No requiere parámetros
  - Requiere autenticación

- `GET /api/stats/analytics/:userId` - Obtiene análisis estadísticos para un usuario específico
  - Path params:
    - `userId` (obligatorio): ID del usuario
  - Requiere autenticación

- `GET /api/stats/category/:category` - Obtiene estadísticas por categoría
  - Path params:
    - `category` (obligatorio): Categoría de análisis (folders, financial, activity, tasks, notifications, matters)
  - Requiere autenticación

- `GET /api/stats/:userId/category/:category` - Obtiene estadísticas por categoría para un usuario específico
  - Path params:
    - `userId` (obligatorio): ID del usuario
    - `category` (obligatorio): Categoría de análisis (folders, financial, activity, tasks, notifications, matters)
  - Requiere autenticación

- `POST /api/stats/generate` - Genera nuevas estadísticas
  - No requiere parámetros
  - Requiere autenticación

- `POST /api/stats/generate/:userId` - Genera nuevas estadísticas para un usuario específico
  - Path params:
    - `userId` (obligatorio): ID del usuario
  - Requiere autenticación

- `POST /api/stats/generate-all` - Genera estadísticas para todos los usuarios
  - No requiere parámetros
  - Requiere autenticación de administrador

### Usuarios y autenticación

- `POST /api/login` - Inicia sesión
  - Body params:
    - `email` (obligatorio): Email del usuario
    - `password` (obligatorio): Contraseña del usuario

- `GET /api/home` - Página principal (requiere autenticación)
  - No requiere parámetros

- `GET /api/users/dashboard` - Dashboard de usuarios (requiere autenticación)
  - No requiere parámetros

## Pruebas

Ejecutar pruebas unitarias:

```bash
npm test
```

Ejecutar pruebas específicas:

```bash
npm test -- --grep "BCRA Service"
```

Ejecutar pruebas unitarias:

```bash
npm run test:unit
```

Ejecutar pruebas de integración:

```bash
npm run test:integration
```

Ejecutar el linter:

```bash
npm run lint
```

## Configuración de Puppeteer

### Instalación optimizada

Para evitar que cada instalación de Puppeteer descargue su propia copia de Chromium (lo que puede resultar en múltiples copias redundantes), recomendamos instalar Puppeteer usando la siguiente configuración:

```bash
# Evitar la descarga automática de Chromium
PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm install puppeteer
```

Esta configuración requiere que tengas una instalación global de Chromium en tu sistema que será utilizada por Puppeteer.

### Configuración con PM2

Si estás utilizando PM2 (como se recomienda para este proyecto), la configuración de Chromium se gestiona a través del archivo `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [
    {
      name: 'law-analytics',
      script: './app.js',
      // ... otras configuraciones
      env: {
        NODE_ENV: 'development',
        PORT: 3000,
        CHROMIUM_PATH: '/usr/bin/chromium-browser'  // Ruta a tu instalación de Chromium
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3000,
        CHROMIUM_PATH: '/usr/bin/chromium-browser'  // Ruta a tu instalación de Chromium
      },
      // ... resto de configuración
    },
  ],
};
```

### Iniciar la aplicación con PM2

```bash
# Usar configuración predeterminada (desarrollo)
pm2 start ecosystem.config.js

# O específicamente para entorno de producción
pm2 start ecosystem.config.js --env production
```

### Configuración sin PM2

Si no estás utilizando PM2, debes asegurarte de establecer la variable de entorno `CHROMIUM_PATH` antes de iniciar la aplicación:

```bash
# Linux/macOS
export CHROMIUM_PATH=/usr/bin/chromium-browser
node app.js

# Windows
set CHROMIUM_PATH=C:\Ruta\A\chromium.exe
node app.js
```

### Solución de problemas

#### Encontrar la ruta correcta de Chromium

Para encontrar la ruta correcta a tu instalación de Chromium:

```bash
# En sistemas Linux
which chromium-browser
# o
which chromium

# En macOS
which chromium

# En Windows, verificar la ubicación de instalación
# Típicamente en:
# C:\Program Files\Chromium\Application\chrome.exe
# o
# C:\Program Files (x86)\Chromium\Application\chrome.exe
```

#### Errores comunes

- **Error `kill EACCES`**: Este error ocurre cuando el usuario que ejecuta la aplicación no tiene permisos para manipular el proceso de Chromium. Para resolverlo:
  - Usa la versión de Chromium que viene con Puppeteer (sin establecer `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD`)
  - Asegúrate de que el usuario tenga permisos adecuados para ejecutar Chromium
  - Considera usar la aplicación con un usuario con más privilegios

- **Error `Failed to launch the browser process`**: Verifica que la ruta especificada en `CHROMIUM_PATH` sea correcta y que Chromium esté instalado.

### Verificación de instalación

Para verificar que Puppeteer puede acceder correctamente a Chromium, puedes ejecutar este script de prueba:

```javascript
// test-puppeteer.js
const puppeteer = require('puppeteer');

(async () => {
  console.log('Ruta de Chromium configurada:', process.env.CHROMIUM_PATH);
  
  try {
    const browser = await puppeteer.launch({
      executablePath: process.env.CHROMIUM_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    console.log('Puppeteer iniciado correctamente');
    const version = await browser.version();
    console.log('Versión del navegador:', version);
    
    await browser.close();
    console.log('Navegador cerrado correctamente');
  } catch (error) {
    console.error('Error al iniciar Puppeteer:', error);
  }
})();
```

Ejecútalo con:

```bash
node test-puppeteer.js
```

## Servicio de Scraping de Tasas Financieras

El sistema incorpora servicios avanzados de scraping para extraer, procesar y almacenar tasas financieras de diversas fuentes. En particular, el servicio de scraping del Banco Nación Argentina (BNA) incluye funcionalidades sofisticadas para manejar diversas situaciones que pueden surgir en la publicación de tasas de interés.

### Arquitectura del Servicio de Scraping

El servicio de scraping está organizado en módulos independientes para cada fuente de datos:

```
server/services/scrapers/
├── tasas/
│   ├── bcraService.js         # Scraping de tasas del BCRA
│   ├── bnaService.js          # Scraping de tasa activa del BNA
│   ├── bnaDescargadorPDF.js   # Descarga de PDFs del BNA
│   ├── bnaProcesadorPDF.js    # Procesamiento de PDFs del BNA
│   ├── colegioService.js      # Scraping desde CPACF
│   └── consejoService.js      # APIs del Consejo
```

Todos los archivos generados por estos servicios (capturas de pantalla, PDFs, HTMLs y archivos de texto extraídos) se guardan en la carpeta `server/files`. Esto facilita la gestión y limpieza de archivos temporales.

### BNA Service - Características Principales

El servicio de scraping del BNA (`bnaService.js`) implementa las siguientes funcionalidades avanzadas:

#### 1. Extracción con Reintentos (Resilient Scraping)

- Implementa una estrategia de reintentos con backoff exponencial
- Manejo inteligente de errores con detección de errores recuperables vs. no recuperables
- Captura de evidencias (screenshots y HTML) automáticas en caso de fallos

```javascript
async function extraerTasaActivaBNAConReintentos(screenshot = false, html = false) {
    // Implementa withRetry para ejecutar la función con reintentos controlados
    return withRetry(
        async (attempt) => {
            // Función principal de extracción con captura de evidencias
        },
        {
            maxRetries: 5,
            initialDelay: 2000,
            maxDelay: 60000,
            factor: 2,
            shouldRetry: (error) => {
                // Lógica para determinar si el error es recuperable
            }
        }
    );
}
```

#### 2. Manejo Avanzado de Fechas de Vigencia

El sistema implementa lógica sofisticada para manejar tres escenarios principales relacionados con las fechas de publicación de tasas. Esto es particularmente importante en el procesamiento de PDFs (`bnaProcesadorPDF.js`), donde los archivos descargados y su texto extraído se guardan en la carpeta `server/files` para análisis y depuración:

##### a) Fecha de Vigencia Actual
Cuando la fecha de publicación coincide con la fecha actual, el sistema simplemente registra el nuevo valor.

##### b) Fecha de Vigencia Futura
Cuando se publica una tasa con fecha de vigencia futura (ej. el 18/04 se publica una tasa con vigencia 21/04):

- El sistema detecta automáticamente que es una fecha futura
- Identifica los días intermedios entre la fecha actual y la fecha de vigencia
- Completa los días intermedios utilizando el último valor conocido en la base de datos
- Registra el nuevo valor para la fecha de vigencia futura

```javascript
// Escenario 1: Fecha de vigencia es futura
if (resultadoProcesado.metaVigencia.esFechaFutura && configTasa) {
    const diasHastaVigencia = [];
    let ultimaFecha = new Date(configTasa.fechaUltima);

    // Si la última fecha registrada es posterior a hoy, usar la fecha de hoy
    if (ultimaFecha > fechaHoy) {
        ultimaFecha = new Date(fechaHoy);
    }
    
    // Generar array de fechas intermedias hasta la fecha de vigencia
    const fechaSiguiente = new Date(ultimaFecha);
    fechaSiguiente.setDate(fechaSiguiente.getDate() + 1);
    
    while (fechaSiguiente < fechaVigencia) {
        const fechaIntermedia = new Date(fechaSiguiente);
        diasHastaVigencia.push(fechaIntermedia);
        fechaSiguiente.setDate(fechaSiguiente.getDate() + 1);
    }
    
    // Si hay días intermedios, marcarlos para completar
    if (diasHastaVigencia.length > 0) {
        resultadoProcesado.metaVigencia.diasHastaVigencia = diasHastaVigencia;
        resultadoProcesado.metaVigencia.requiereCompletarIntermedio = true;
    }
}
```

##### c) Fecha de Vigencia Pasada
Cuando se publica una tasa con fecha de vigencia pasada (ej. el 18/04 se publica una tasa con vigencia 13/04):

- El sistema detecta que es una fecha pasada
- Identifica los días entre la fecha de vigencia y la fecha actual
- Completa todos los días desde la fecha de vigencia hasta hoy con el valor de la nueva publicación
- Esto garantiza consistencia histórica cuando se publican actualizaciones retroactivas

```javascript
// Escenario 2: Fecha de vigencia es pasada
else if (resultadoProcesado.metaVigencia.esFechaPasada) {
    const diasHastaHoy = [];
    
    // Generar array de fechas desde el día siguiente a la fecha de vigencia hasta hoy
    const fechaSiguiente = new Date(fechaVigencia);
    fechaSiguiente.setDate(fechaSiguiente.getDate() + 1);
    
    while (fechaSiguiente <= fechaHoy) {
        const fechaIntermedia = new Date(fechaSiguiente);
        diasHastaHoy.push(fechaIntermedia);
        fechaSiguiente.setDate(fechaSiguiente.getDate() + 1);
    }
    
    // Si hay días para completar, marcarlos
    if (diasHastaHoy.length > 0) {
        resultadoProcesado.metaVigencia.diasDesdeVigencia = diasHastaHoy;
        resultadoProcesado.metaVigencia.requiereCompletarDesdeVigencia = true;
        resultadoProcesado.metaVigencia.fechaReferenciaPublicacion = fechaVigencia;
    }
}
```

#### 3. Completado Automático de Fechas Faltantes

El sistema mantiene un registro de fechas faltantes en la colección `TasasConfig` y proporciona mecanismos para completar automáticamente estos huecos:

```javascript
async function completarDiasIntermedios(tipoTasa, diasIntermedios, datosUltimoRegistro) {
    // Completa los días intermedios usando una fuente de datos de referencia
    // Actualiza la lista de fechasFaltantes en TasasConfig
    // Genera metadatos detallados para cada fecha completada
}
```

#### 4. Manejo de Continuidad de Verificaciones

El sistema detecta y maneja interrupciones en la continuidad de las verificaciones:

- Detecta gaps en las verificaciones diarias
- Registra las fechas faltantes para su posterior procesamiento
- Proporciona información detallada sobre la continuidad de las verificaciones

```javascript
const informacionContinuidad = {
    ultimaVerificacion: configTasa.fechaUltima,
    diasDesdeUltimaVerificacion,
    hayContinuidad: diasDesdeUltimaVerificacion <= 1,
    fechasFaltantes: configTasa.fechasFaltantes || []
};

// Si hay un gap de más de 1 día, registrar los días faltantes
if (diasDesdeUltimaVerificacion > 1) {
    const diasFaltantes = [];
    const fechaTmp = new Date(ultimaVerificacionDate);
    fechaTmp.setDate(fechaTmp.getDate() + 1);

    // Iterar hasta el día anterior a hoy
    while (fechaTmp < fechaHoy) {
        const fechaFaltante = new Date(fechaTmp);
        diasFaltantes.push(fechaFaltante);
        fechaTmp.setDate(fechaTmp.getDate() + 1);
    }

    informacionContinuidad.nuevosDiasFaltantes = diasFaltantes;
}
```

#### 5. Registro Detallado de Metadatos

Cada registro de tasa incluye metadatos enriquecidos para facilitar la auditoría y trazabilidad:

- Origen de los datos (scraping directo, completado automático, etc.)
- Timestamp de procesamiento y publicación
- Referencias a la fuente original
- Información sobre modificaciones y actualizaciones

```javascript
// Añadir registro de esta publicación para llevar el control
resultadoProcesado.metaPublicacion = {
    fechaPublicacion: new Date().toISOString(),
    fechaVigencia: fechaVigencia.toISOString(),
    origen: 'bnaService',
    valores: {
        tna: datosTasaActiva.tna,
        tem: datosTasaActiva.tem,
        tea: datosTasaActiva.tea
    }
};
```

#### 6. Gestión de Errores y Registro

El sistema incorpora un registro detallado de errores en la colección `TasasConfig`:

```javascript
async function registrarErrorTasa(tipoTasa, taskId, mensaje, detalleError = '', codigo = '') {
    try {
        // Obtener configuración de la tasa
        const config = await TasasConfig.findOne({ tipoTasa });
        
        // Registrar el error en la configuración
        await config.registrarError(taskId, mensaje, detalleError, codigo);
        return true;
    } catch (error) {
        logger.error(`Error al registrar error en TasasConfig: ${error.message}`);
        return false;
    }
}
```

#### 7. Optimización para Múltiples Tasas Derivadas

El sistema procesa y guarda múltiples tasas derivadas en una sola operación:

```javascript
// Actualiza la tasa activa BNA y tasas relacionadas
exports.guardarTasaActivaBNA = async (data) => {
  return await exports.actualizarTasa(
    data,
    'tasaActivaBNA',
    (datos) => {
      // Calcular el valor como TEM / 30
      return datos.tem / 30;
    },
    [
      {
        tipo: 'tasaActivaCNAT2658',
        calcularValor: (datos) => {
          // Calcular el valor como TEA / 365
          return datos.tea / 365;
        }
      },
      {
        tipo: 'tasaActivaTnaBNA',
        calcularValor: (datos) => {
          return datos.tna / 365
        }
      },
      {
        tipo: 'tasaActivaCNAT2764',
        calcularValor: (datos) => {
          return datos.tea / 365;
        }
      }
    ],
  );
};
```

### Colegio Service - Funcionalidades

El servicio de scraping del Colegio Público de Abogados (`colegioService.js`) incluye:

- Soporte para autenticación y mantenimiento de sesión
- Navegación y extracción de datos de la interfaz web del CPACF
- Procesamiento de fechas faltantes específicas desde `TasasConfig`
- Optimización de manejo de fechas con timezone UTC para evitar problemas de día

```javascript
async function findMissingDataColegio(options) {
    try {
        // Obtener config específica para este tipo de tasa
        const config = await TasasConfig.findOne({ tipoTasa: options.tipoTasa });
        
        // Verificar si hay fechas faltantes específicas
        if (config && config.fechasFaltantes && config.fechasFaltantes.length > 0) {
            // Convertir fechas a formato UTC para comparación correcta
            const fechasFormateadas = config.fechasFaltantes.map(fecha => {
                // Asegurar que estamos trabajando con fechas UTC
                const fechaUTC = new Date(Date.UTC(
                    fecha.getUTCFullYear(),
                    fecha.getUTCMonth(),
                    fecha.getUTCDate()
                ));
                return {
                    fecha: fechaUTC,
                    fechaFormateada: moment(fechaUTC).format('DD/MM/YYYY')
                };
            });
            
            // Ordenar fechas cronológicamente
            fechasFormateadas.sort((a, b) => a.fecha - b.fecha);
            
            // Filtrar fechas futuras
            const fechaHoy = new Date();
            fechaHoy.setUTCHours(0, 0, 0, 0);
            
            const fechasFiltradas = fechasFormateadas.filter(item => item.fecha <= fechaHoy);
            
            return fechasFiltradas;
        }
        
        // Si no hay fechas faltantes específicas, usar el rango proporcionado
        return generarRangoFechas(options.fechaDesde, options.fechaHasta);
    } catch (error) {
        logger.error(`Error al buscar fechas faltantes para ${options.tipoTasa}: ${error.message}`);
        // Si hay error, caer en el comportamiento por defecto
        return generarRangoFechas(options.fechaDesde, options.fechaHasta);
    }
}
```

## Configuración

La configuración se maneja a través de variables de entorno y el archivo `config/index.js`. Las variables críticas se pueden almacenar en AWS SecretsManager.

### Variables de entorno importantes

- `NODE_ENV`: Entorno de ejecución (development, production)
- `PORT`: Puerto en el que se ejecutará la aplicación
- `MONGODB_URI`: URI de conexión a MongoDB
- `JWT_SECRET`: Secreto para generar tokens JWT
- `AWS_REGION`: Región de AWS para los servicios de SecretsManager y SES
- `AWS_ACCESS_KEY_ID`: ID de clave de acceso a AWS
- `AWS_SECRET_ACCESS_KEY`: Clave secreta de acceso a AWS
- `CHROMIUM_PATH`: Ruta al ejecutable de Chromium
- `CPACF_USER`: Usuario para acceder a CPACF
- `CPACF_PASSWORD`: Contraseña para acceder a CPACF

## Licencia

Este proyecto está licenciado bajo la Licencia MIT - ver el archivo LICENSE para más detalles.