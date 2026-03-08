const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../utils/logger');
const User = require("../models/users")
/**
 * Middleware para verificar la autenticación del usuario
 * 
 * Verifica que el token JWT sea válido y añade los datos del usuario
 * a la solicitud para uso en controladores posteriores.
 * 
 * @param {Object} req - Objeto de solicitud Express
 * @param {Object} res - Objeto de respuesta Express
 * @param {Function} next - Función para continuar con el siguiente middleware
 */
exports.verificaAutenticacion = async (req, res, next) => {
  try {
    // Obtener token de las cookies
    const token = req.cookies.access_token;
    console.log(token, req.cookies)
    if (!token) {
      logger.warn('Intento de acceso sin token de autenticación');

      return res.status(401).json({
        ok: false,
        status: 401,
        error: 'No se proporcionó token de autenticación'
      });
    }

    // Verificar token
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      logger.warn(`Token de autenticación inválido: ${err.message}`);

      return res.status(401).json({
        ok: false,
        status: 401,
        error: 'Token de autenticación inválido o expirado'
      });
    }

    // El token decodificado tiene el formato { id: '...', iat: ..., exp: ... }
    logger.debug(`Token decodificado: ${JSON.stringify(decoded)}`);

    // Buscar el usuario en la base de datos usando el ID del token
    const userId = decoded.id;

    if (!userId) {
      logger.warn('Token no contiene ID de usuario');

      return res.status(401).json({
        ok: false,
        status: 401,
        error: 'Token de autenticación inválido (sin ID)'
      });
    }

    // Buscar usuario por ID
    const usuario = await User.findById(userId);

    if (!usuario) {
      logger.warn(`Usuario no encontrado con ID: ${userId}`);

      return res.status(401).json({
        ok: false,
        status: 401,
        error: 'Usuario no encontrado'
      });
    }

    // Verificar si el usuario tiene estado activo (si aplica en tu modelo)
    if (usuario.estado === false) {
      logger.warn(`Intento de acceso con usuario inactivo: ${usuario.email}`);

      return res.status(403).json({
        ok: false,
        status: 403,
        error: 'Usuario inactivo o suspendido'
      });
    }

    // Añadir el usuario completo a la solicitud
    req.usuario = usuario;

    logger.debug(`Usuario autenticado: ${usuario.email}`);
    next();

  } catch (error) {
    logger.error(`Error en verificación de autenticación: ${error.message}`);

    return res.status(500).json({
      ok: false,
      status: 500,
      error: 'Error al verificar autenticación'
    });
  }
};

/**
 * Middleware para verificar si el usuario tiene rol de administrador
 * 
 * @param {Object} req - Objeto de solicitud Express
 * @param {Object} res - Objeto de respuesta Express
 * @param {Function} next - Función para continuar con el siguiente middleware
 */
exports.verificaAdmin = (req, res, next) => {
  try {
    // Debe ejecutarse después de verificaAutenticacion
    if (!req.usuario) {
      return res.status(500).json({
        ok: false,
        status: 500,
        error: 'Error en verificación de rol: Usuario no autenticado'
      });
    }

    // Verificar rol
    if (req.usuario.role !== 'ADMIN') {
      logger.warn(`Intento de acceso a recurso administrativo por usuario sin permisos: ${req.usuario.email}`);

      return res.status(403).json({
        ok: false,
        status: 403,
        error: 'No tiene permisos para acceder a este recurso'
      });
    }

    logger.debug(`Acceso administrativo autorizado: ${req.usuario.email}`);
    next();
  } catch (error) {
    logger.error(`Error en verificación de rol administrativo: ${error.message}`);

    return res.status(500).json({
      ok: false,
      status: 500,
      error: 'Error al verificar permisos administrativos'
    });
  }
};