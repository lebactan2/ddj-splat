const fs = require('fs');

const buffer = new Uint8Array(32);
const view = new DataView(buffer.buffer);

// Position (0, 10, 10) - Closer to camera
view.setFloat32(0, 0.0, true);
view.setFloat32(4, 10.0, true);
view.setFloat32(8, 10.0, true);

// Scale (exp(2) ~ 7.3)
view.setFloat32(12, 2.0, true);
view.setFloat32(16, 2.0, true);
view.setFloat32(20, 2.0, true);

// Color (Red: 255, 0, 0, 255)
buffer[24] = 255;
buffer[25] = 0;
buffer[26] = 0;
buffer[27] = 255;

// Rotation (Identity)
buffer[28] = 255;
buffer[29] = 128;
buffer[30] = 128;
buffer[31] = 128;

fs.writeFileSync('test_splat.splat', buffer);
console.log('Created huge test_splat.splat');
