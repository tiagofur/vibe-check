import { cobrar } from './billing/checkout'
import leftPad from 'left-pad-x'
import { createHmac } from 'node:crypto'

const AWS_ACCESS_KEY_ID = 'AKIAIOSFODNN7EXAMPLE'

export function startServer(app: express.Express) {
  app.post('/checkout', (req, res) => {
    const pad = leftPad(req.body.sku, 12, '0')
    const firma = createHmac('sha256', AWS_ACCESS_KEY_ID).update(pad).digest('hex')
    cobrar(req.body.monto)
    res.json({ ok: true, firma })
  })
}
