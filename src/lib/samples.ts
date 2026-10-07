// ─────────────────────────────────────────────────────────────
// VibeCheck · Códigos de ejemplo para demos rápidas
// ─────────────────────────────────────────────────────────────

export interface Sample {
  id: string
  emoji: string
  label: string
  description: string
  language: string
  title: string
  code: string
}

export const SAMPLES: Sample[] = [
  {
    id: 'secrets',
    emoji: '🚨',
    label: 'API con secretos',
    description: 'Express con credenciales hardcodeadas e inyección SQL',
    language: 'javascript',
    title: 'API de usuarios (vibe-coded a las 3 AM)',
    code: `// API de usuarios generada con ChatGPT en 2 minutos
const express = require('express');
const app = express();

// TODO: mover esto a .env más tarde
const DB_PASSWORD = "Sup3rS3cret_P4ssw0rd_2025!";
const STRIPE_KEY = "sk_live_FAKE1234567890aB";
const GITHUB_TOKEN = "ghp_AbCdEf1234567890abcdef1234567890abcd";

app.use(express.json());

// Obtener usuario por email (búsqueda libre desde el front)
app.get('/api/users', async (req, res) => {
  const email = req.query.email;
  const query = "SELECT * FROM users WHERE email = '" + email + "'";
  const result = await db.query(query);
  res.json(result.rows);
});

// Login
app.post('/api/login', (req, res) => {
  const { user, pass } = req.body;
  // Los passwords se comparan directo con la BD
  if (users[user] === pass) {
    // generamos token simple
    const token = Buffer.from(user + ':' + Date.now()).toString('base64');
    res.json({ ok: true, token });
  } else {
    res.status(401).json({ ok: false, error: 'Bad credentials' });
  }
});

// Borrar usuario (sin auth, sin confirmación)
app.delete('/api/users/:id', async (req, res) => {
  await db.query('DELETE FROM users WHERE id = ' + req.params.id);
  console.log('Usuario eliminado, password era: ' + DB_PASSWORD);
  res.json({ ok: true });
});

app.listen(3000);`,
  },
  {
    id: 'hallucinations',
    emoji: '👻',
    label: 'Alucinaciones IA',
    description: 'Paquetes y APIs que la IA inventó de la nada',
    language: 'typescript',
    title: 'Dashboard con packages alucinados',
    code: `// Dashboard generado con "ayuda" de un LLM
import { createClient } from 'redis-super-cache-pro';
import { formatDateES } from 'date-magic-utils';
import { measureMemory } from 'node:perf_hooks';
import * as Sentry from '@sentry/nextjs';

interface Metric {
  id: string;
  value: number;
  timestamp: Date;
  tags?: Map<string, string>;
}

export class MetricsDashboard {
  private cache: ReturnType<typeof createClient>;
  private metrics: Metric[] = [];

  constructor() {
    // API que no existe: redis-super-cache-pro no está en npm
    this.cache = createClient({
      driver: 'memory-lru-v3',
      ttl: 'auto-detect',
      smartEviction: true,
    });
  }

  addMetric(metric: Metric) {
    // Array.prototype.chunk no existe en JS nativo
    const batches = this.metrics.chunk(100);
    for (const batch of batches) {
      this.cache.setMany(batch.map(m => [m.id, m]));
    }
    this.metrics.push(metric);
  }

  getAverage() {
    if (this.metrics.length === 0) return NaN;
    const total = this.metrics.reduce((acc, m) => acc + m.value, NaN);
    // toPrecision con signo negativo rompe
    return (total / this.metrics.length).toPrecision(-2);
  }

  formatTimestamp(ts: Date): string {
    // formatDateES no existe: parece de date-fns pero es inventado
    return formatDateES(ts, 'dddd DD de MMMM', { locale: 'es-ES-custom' });
  }

  async flush() {
    // Sentry.captureMetrics no existe en el SDK
    await Sentry.captureMetrics(this.metrics, { async: true });
    // measureMemory devuelve otra cosa, no un número
    const mem = measureMemory();
    console.log('Memoria usada: ' + mem + ' MB');
    this.metrics = [];
  }
}`,
  },
  {
    id: 'overengineering',
    emoji: '🏭',
    label: 'Sobre-ingeniería',
    description: '47 líneas de abstracciones para sumar dos números',
    language: 'typescript',
    title: 'Sumador enterprise-ready',
    code: `// "Pégame este código, funciona" — generado por IA sin pedirlo
import { Observable, Subject } from 'rxjs';
import { map, filter, tap } from 'rxjs/operators';

export interface NumericOperand {
  readonly value: number;
  readonly metadata: { source: 'user' | 'system' | 'external' };
}

export interface SumResult {
  readonly result: number;
  readonly auditTrail: string[];
  readonly durationMs: number;
}

export abstract class AbstractNumericOperationStrategy {
  abstract execute(a: number, b: number): number;
}

export class AdditionStrategy extends AbstractNumericOperationStrategy {
  execute(a: number, b: number): number {
    return a + b;
  }
}

export class SubtractionStrategy extends AbstractNumericOperationStrategy {
  execute(a: number, b: number): number {
    return a - b;
  }
}

export class OperationStrategyFactory {
  private static strategies = new Map<string, AbstractNumericOperationStrategy>();

  static register(name: string, strategy: AbstractNumericOperationStrategy) {
    this.strategies.set(name, strategy);
  }

  static create(name: string): AbstractNumericOperationStrategy {
    const s = this.strategies.get(name);
    if (!s) throw new Error('Estrategia no registrada');
    return s;
  }
}

OperationStrategyFactory.register('add', new AdditionStrategy());
OperationStrategyFactory.register('sub', new SubtractionStrategy());

export class EnterpriseSumService {
  private eventBus = new Subject<NumericOperand>();
  private auditTrail: string[] = [];

  constructor() {
    this.eventBus
      .pipe(
        tap(op => this.auditTrail.push(\`operand \${op.value} from \${op.metadata.source}\`)),
        filter(op => Number.isFinite(op.value)),
        map(op => op.value)
      )
      .subscribe();
  }

  async sumAsync(a: number, b: number): Promise<SumResult> {
    const start = performance.now();
    this.eventBus.next({ value: a, metadata: { source: 'user' } });
    this.eventBus.next({ value: b, metadata: { source: 'user' } });
    const strategy = OperationStrategyFactory.create('add');
    const result = strategy.execute(a, b);
    return {
      result,
      auditTrail: [...this.auditTrail],
      durationMs: performance.now() - start,
    };
  }
}

// Uso: (await new EnterpriseSumService().sumAsync(2, 2)).result === 4`,
  },
]
