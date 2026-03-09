const express = require('express');
const router = express.Router();
const tasasController = require('../controllers/tasasController');
const tasasConfigController = require("../controllers/tasasConfigController")
const { verificaAutenticacion, verificaAdmin } = require('../middlewares/auth');

// Aplicar middleware de autenticación a todas las rutas
router.use(verificaAutenticacion);

// Ruta unificada para obtener datos por rango de fechas y campo específico
// Permite obtener todo el rango o solo los extremos usando el parámetro completo
// Ejemplo: /api/tasas/consulta?fechaDesde=2023-01-01&fechaHasta=2023-01-31&campo=tasaPasivaBNA&completo=true
router.get('/consulta', tasasController.consultarPorFechas);
router.get('/listado', tasasConfigController.obtenerTasasConfig);
router.get('/status', tasasConfigController.getTasasStatus);
router.post('/update', verificaAdmin, tasasController.updateTasas);
router.put('/valor', verificaAdmin, tasasController.actualizarValorDirecto);

module.exports = router;