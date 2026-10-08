# mi-app-vibe

API de ejemplo "vibe-coded" para los tests de VibeCheck: cada defecto fue
plantado a propósito (los secretos son ficticios, tomados de la documentación
de AWS/Stripe). No instalar, no ejecutar.

Defectos plantados: secretos (AWS/Stripe/DB), `.env` commiteado, import
fantasma local, dependencia fantasma (`left-pad-x`), dependencia muerta
(`lodash`), archivo huérfano (`src/billing/pagos.ts`) y tests falsos
(`login.test.ts`: tautología + cuerpo vacío + skip; `session.test.ts`:
suite sin ni un assert).
