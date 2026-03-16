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
    enum: ['tasaPasivaBNA', 'tasaPasivaBCRA', 'tasaActivaBNA', 'tasaActivaTnaBNA', 'cer', 'icl', 'tasaActivaCNAT2601', 'tasaActivaCNAT2658', 'tasaActivaCNAT2764', 'tasaPasivaBP', 'tasaActivaBPDolares', 'tasaPasivaBPDolares'],
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