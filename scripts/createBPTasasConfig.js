require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');

mongoose.connect(process.env.URLDB).then(async () => {
  const TasasConfig = require(path.join(__dirname, '../server/models/tasasConfig'));
  const Tasas = require(path.join(__dirname, '../server/models/tasas'));

  const tasas = [
    { tipoTasa: 'tasaPasivaBP',        descripcion: 'Tasa Pasiva Banco Provincia' },
    { tipoTasa: 'tasaActivaBPDolares', descripcion: 'Tasa Activa Banco Provincia en Dólares' },
    { tipoTasa: 'tasaPasivaBPDolares', descripcion: 'Tasa Pasiva Banco Provincia en Dólares' },
  ];

  for (const { tipoTasa, descripcion } of tasas) {
    const min = await Tasas.findOne({ [tipoTasa]: { $exists: true, $ne: null } }).sort({ fecha: 1 }).lean();
    const max = await Tasas.findOne({ [tipoTasa]: { $exists: true, $ne: null } }).sort({ fecha: -1 }).lean();
    if (!min || !max) { console.log(tipoTasa + ': sin datos en Tasas, saltando'); continue; }
    const doc = await TasasConfig.findOneAndUpdate(
      { tipoTasa },
      { tipoTasa, descripcion, activa: true, fechaInicio: min.fecha, fechaUltima: max.fecha, fechaUltimaCompleta: max.fecha, fechasFaltantes: [] },
      { upsert: true, new: true }
    );
    console.log('Creado:', doc.tipoTasa, '| desde:', doc.fechaInicio.toISOString().slice(0,10), '| hasta:', doc.fechaUltima.toISOString().slice(0,10));
  }

  await mongoose.connection.close();
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
