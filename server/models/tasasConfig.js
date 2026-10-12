const mongoose = require('mongoose');
let Schema = mongoose.Schema;

// Esquema para el registro de errores de scraping
const errorScrapingSchema = new Schema({
  fecha: {
    type: Date,
    default: Date.now
  },
  taskId: {
    type: String,
    required: true
  },
  mensaje: {
    type: String,
    required: true
  },
  detalleError: {
    type: String
  },
  codigo: {
    type: String
  },
  intentos: {
    type: Number,
    default: 1
  },
  resuelto: {
    type: Boolean,
    default: false
  }
});

let tasasConfigSchema = new Schema({
  tipoTasa: {
    type: String,
    required: true,
    enum: ['tasaPasivaBNA', 'tasaPasivaBCRA', 'tasaActivaBNA', 'tasaActivaTnaBNA', 'cer', 'icl', 'tasaActivaCNAT2601', 'tasaActivaCNAT2630', 'tasaActivaCNAT2658', 'tasaActivaCNAT2764', 'tasaPasivaBP', 'tasaActivaBP', 'tasaActivaBPDolares', 'tasaPasivaBPDolares', 'tasaPasivaBCRA27802', 'uva', 'uvi', 'tasaBADLAR', 'tasaTAMAR', 'tasaTM20', 'inflacionMensual', 'ripte', 'ipc'],
    unique: true
  },
  fechaInicio: {
    type: Date,
    required: true
  },
  fechaUltima: {
    type: Date,
    required: true
  },
  // Última fecha con datos completos desde fechaInicio
  fechaUltimaCompleta: {
    type: Date
  },
  fechasFaltantes: [{
    type: Date
  }],
  // Determina la fórmula de cálculo en law-analytics-server:
  //   'indexado'            → índice base 1 (CER, ICL)
  //   'porcentajeAcumulado' → % acumulado desde fecha base (tasaPasivaBCRA / 27802)
  //   'interesDiario'       → sumatoria de TNAs diarias
  tipoIndice: {
    type: String,
    enum: ['indexado', 'interesDiario', 'porcentajeAcumulado', 'variacionMensual', 'indiceMensual']
  },
  ultimaVerificacion: {
    type: Date,
    default: Date.now
  },
  descripcion: {
    type: String
  },
  activa: {
    type: Boolean,
    default: true
  },
  // Indica que la tasa fue discontinuada oficialmente y no se actualizará más.
  // Se excluye del chequeo de estado (no aparece como desactualizada).
  discontinuada: {
    type: Boolean,
    default: false
  },
  // Fecha oficial en que la tasa dejó de actualizarse (opcional, informativa)
  fechaFin: {
    type: Date
  },
  // Configuración por serie (catálogo en admin/server/utils/tasasIndices.js). Define cómo se
  // computan rango, faltantes y atraso según cómo publica la fuente.
  periodicidad: {
    type: String,
    enum: ['diaria', 'diariaHabil', 'mensual'],
    default: 'diaria'
  },
  coleccion: {
    type: String,
    enum: ['tasas', 'indicesmensuales'],
    default: 'tasas'
  },
  fuente: {
    type: String
  },
  unidadOrigen: {
    type: String
  },
  unidadAlmacenada: {
    type: String
  },
  // Días de atraso normales de la fuente: dentro de ese margen la serie no se considera desactualizada
  atrasoPublicacionDias: {
    type: Number,
    default: 0
  },
  // Último mes publicado (YYYY-MM), solo series mensuales
  ultimoPeriodo: {
    type: String
  },
  // Vigencia jurídica (la lee el motor de intereses del hub, services/tasasCalculoService.js).
  // Una tasa no vigente se sigue ofreciendo, pero el cálculo devuelve `avisoVigencia`.
  vigente: {
    type: Boolean,
    default: true
  },
  avisoVigencia: {
    type: String
  },
  norma: {
    type: String
  },
  vigenciaDesde: {
    type: Date
  },
  vigenciaHasta: {
    type: Date
  },
  // Lista de errores de scraping relacionados con esta tasa
  erroresScraping: [errorScrapingSchema]
});

// Método para registrar un nuevo error de scraping
tasasConfigSchema.methods.registrarError = async function(taskId, mensaje, detalleError = '', codigo = '') {
  // Verificar si ya existe un error similar no resuelto
  const errorExistente = this.erroresScraping.find(err => 
    !err.resuelto && err.taskId === taskId && err.mensaje === mensaje
  );

  if (errorExistente) {
    // Incrementar contador de intentos si es el mismo error
    errorExistente.intentos += 1;
    errorExistente.fecha = new Date(); // Actualizar fecha
    if (detalleError) {
      errorExistente.detalleError = detalleError;
    }
  } else {
    // Crear nuevo registro de error
    this.erroresScraping.push({
      taskId,
      mensaje,
      detalleError,
      codigo,
      fecha: new Date()
    });
  }
  
  return this.save();
};

// Método para marcar errores como resueltos
tasasConfigSchema.methods.resolverErrores = async function(taskId = null) {
  if (taskId) {
    // Resolver solo los errores de una tarea específica
    this.erroresScraping.forEach(error => {
      if (error.taskId === taskId && !error.resuelto) {
        error.resuelto = true;
      }
    });
  } else {
    // Resolver todos los errores no resueltos
    this.erroresScraping.forEach(error => {
      if (!error.resuelto) {
        error.resuelto = true;
      }
    });
  }
  
  return this.save();
};

// Método estático para obtener todas las tasas con errores no resueltos
tasasConfigSchema.statics.obtenerTasasConErrores = function() {
  return this.find({
    "erroresScraping": { 
      $elemMatch: { 
        "resuelto": false 
      } 
    }
  });
};

module.exports = mongoose.model('TasasConfig', tasasConfigSchema);