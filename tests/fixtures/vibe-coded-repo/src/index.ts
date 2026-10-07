import express from 'express'
import { startServer } from './server'
import { login } from './auth/login'

const app = express()

startServer(app)
login('admin', process.env.ADMIN_PASSWORD ?? 'dev')
