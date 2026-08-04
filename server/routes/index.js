const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');

// Importar todas las rutas específicas
const tasasRoutes = require('./tasasRoutes');
const tasksRoutes = require('./tasksRoutes');
const analysisRoutes = require('./statsAnalysisRoutes');
const valoresArancelariosRoutes = require('./valoresArancelariosRoutes');

// Configurar una ruta base para verificar que la API está funcionando
router.get('/', (req, res) => {
  res.status(200).json({
    status: 'success',
    message: 'API de Tasas funcionando correctamente',
    apiVersion: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Registrar todas las rutas
router.use('/tasas', tasasRoutes);
router.use('/tasks', tasksRoutes);
router.use('/stats', analysisRoutes);
router.use('/valores-arancelarios', valoresArancelariosRoutes);

if (process.env.NODE_ENV === 'development') {
  const tasksDevRoutes = require('./tasksDevRoutes');
  const tasasDevRoutes = require('./tasasDevRoutes');
  const analysisDevRoutes = require('./statAnalysisDevRoutes')
  router.use('/dev/tasks', tasksDevRoutes);
  router.use('/dev/tasas', tasasDevRoutes);
  router.use('/dev/stats', analysisDevRoutes);
  logger.warn('¡ATENCIÓN! Rutas de desarrollo sin autenticación habilitadas en /api/dev/tasks - /api/dev/tasas - /api/dev/stats');

}

// Aquí puedes agregar otras rutas cuando las necesites
// router.use('/otroRecurso', otroRecursoRoutes);

// Middleware para manejar rutas no encontradas
router.use('*', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `Ruta no encontrada: ${req.originalUrl}`
  });
});

module.exports = router;