import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  /*
   * Pin the workspace root. Turbopack otherwise walks up looking for a lockfile
   * and can find an unrelated one in a parent directory (a stray
   * package-lock.json in the user's home folder, for instance), which makes it
   * resolve modules from outside the project.
   */
  turbopack: {
    root: path.resolve(__dirname),
  },
}

export default nextConfig
