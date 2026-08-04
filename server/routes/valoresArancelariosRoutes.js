const express = require('express');
const router = express.Router();
const valoresArancelariosController = require('../controllers/valoresArancelariosController');
const { verificaAutenticacion, verificaAdmin } = require('../middlewares/auth');

// Solo admins: dispara scraping de fuentes externas y puede emitir post + correo.
router.use(verificaAutenticacion, verificaAdmin);

// POST /api/valores-arancelarios/sync           - sincroniza todas las jurisdicciones
// POST /api/valores-arancelarios/sync/:clave    - sincroniza una (uma-pjn, jus-pba, ...)
router.post('/sync', valoresArancelariosController.sincronizarTodas);
router.post('/sync/:clave', valoresArancelariosController.sincronizarUna);

module.exports = router;
