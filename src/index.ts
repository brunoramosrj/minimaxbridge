import 'dotenv/config'
import { loadCredentialEnvironment } from './core/credentials.js'

loadCredentialEnvironment()

const { startServer } = await import('./api/server.js')

startServer().catch(error => {
  console.error('Failed to start server:', error)
  process.exit(1)
})
