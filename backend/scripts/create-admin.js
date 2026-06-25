import bcrypt from 'bcryptjs'
import { pool } from '../src/db.js'

const [, , username, password] = process.argv
if (!username || !password) {
  console.error('uso: node scripts/create-admin.js <username> <senha>')
  process.exit(1)
}

const hash = bcrypt.hashSync(password, 10)
await pool.query(
  `INSERT INTO users (username, password_hash, role)
   VALUES ($1, $2, 'admin')
   ON CONFLICT (username)
   DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
  [username, hash]
)
console.log('✅ admin pronto:', username)
process.exit(0)
