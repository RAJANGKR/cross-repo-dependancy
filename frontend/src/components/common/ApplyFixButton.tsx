import { GitPullRequestArrow } from 'lucide-react'
import { log } from '../../lib/localStore'
import { Button } from './Button'
import { useToast } from './Controls'

interface ApplyFixButtonProps {
  /** GitHub's edit page for the manifest, or null when it cannot be built. */
  url: string | null
  /** The fix line, copied to the clipboard on the way. */
  line: string
  /** Package name, for the accessible name and the activity log. */
  packageName: string
  /** Why the button is disabled when `url` is null. */
  unavailableReason?: string
}

/**
 * Takes the user to GitHub's own editor for the manifest with the fix line on
 * the clipboard. They paste it and choose "Propose changes", and GitHub
 * creates the branch and the pull request. DriftLock never writes to a
 * repository itself, so it needs no write permission.
 */
export function ApplyFixButton({ url, line, packageName, unavailableReason }: ApplyFixButtonProps) {
  const toast = useToast()

  const open = async () => {
    if (!url) return
    let copied = true
    try {
      await navigator.clipboard.writeText(line)
    } catch {
      copied = false
    }
    window.open(url, '_blank', 'noopener,noreferrer')
    log('fix', `Opened GitHub to apply the fix for ${packageName}`)
    toast(
      copied
        ? 'Fix copied. Paste it over the old line on GitHub, then choose Propose changes to open a pull request.'
        : 'GitHub opened. Copy the fix line from here, paste it there, then choose Propose changes.',
    )
  }

  return (
    <Button
      size="sm"
      variant="primary"
      disabled={!url}
      title={url ? undefined : (unavailableReason ?? 'Only available for GitHub repositories')}
      aria-label={`Open pull request on GitHub for ${packageName}`}
      onClick={() => void open()}
    >
      <GitPullRequestArrow aria-hidden="true" />
      Open pull request on GitHub
    </Button>
  )
}
