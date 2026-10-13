import type { ManifestFilename } from '../api/types'
import { MAX_PASTED_FILE_BYTES } from '../config'

const PACKAGE_JSON_KEYS = ['dependencies', 'devDependencies', 'peerDependencies', 'name']

const OPERATOR = '(?:===|==|>=|<=|~=|!=|>|<)'
const REQUIREMENT_LINE = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]*(?:\\[[^\\]]*\\])?\\s*(?:${OPERATOR}\\s*[^\\s,;#]+(?:\\s*,\\s*${OPERATOR}\\s*[^\\s,;#]+)*)?\\s*(?:;[^#]*)?(?:\\s+#.*)?$`,
)
const REQUIREMENT_DIRECTIVE = /^(?:#|-r\s|-c\s|-e\s|--)/

function parseJsonObject(content: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(content)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Guesses the manifest type from pasted content. Returns null when unsure. */
export function detectManifestType(content: string): ManifestFilename | null {
  const text = content.trim()
  if (!text) return null

  if (text.startsWith('{')) {
    const parsed = parseJsonObject(text)
    return parsed && PACKAGE_JSON_KEYS.some((key) => key in parsed) ? 'package.json' : null
  }

  if (text.includes('<project') || text.includes('<dependencies') || text.includes('<?xml')) {
    return 'pom.xml'
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  const requirements = lines.filter((line) => !REQUIREMENT_DIRECTIVE.test(line))
  const allMatch = requirements.every((line) => REQUIREMENT_LINE.test(line))
  return allMatch && requirements.length > 0 ? 'requirements.txt' : null
}

export function contentByteSize(content: string): number {
  return new TextEncoder().encode(content).length
}

/**
 * Checks pasted content against the chosen type. Returns an error sentence for
 * the project card, or null when the file can be sent.
 */
export function validateManifestContent(type: ManifestFilename, content: string): string | null {
  if (contentByteSize(content) > MAX_PASTED_FILE_BYTES) {
    return 'This file is over the 200 KB limit and will not be sent'
  }
  const text = content.trim()
  if (!text) return null
  if (type === 'package.json' && !parseJsonObject(text)) {
    return 'This is not valid JSON, so it cannot be read as package.json'
  }
  if (type === 'pom.xml' && !text.includes('<project') && !text.includes('<dependencies')) {
    return 'No <project> or <dependencies> element found, so it cannot be read as pom.xml'
  }
  return null
}

export const EXAMPLE_MANIFESTS: Record<ManifestFilename, string> = {
  'package.json': `{
  "name": "example-service",
  "dependencies": {
    "axios": "^0.27.2",
    "lodash": "^4.17.20"
  }
}`,
  'requirements.txt': `# example service
pydantic==1.10.13
requests>=2.25,<2.26`,
  'pom.xml': `<project>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>2.9.10</version>
    </dependency>
  </dependencies>
</project>`,
}
