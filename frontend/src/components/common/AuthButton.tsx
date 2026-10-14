import { FolderGit2, LogIn, LogOut } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { navigate, ROUTE_PATHS } from '../../hooks/useRoute'
import { Button } from './Button'
import { Menu, MenuItem, useToast } from './Controls'

/**
 * "Sign in with GitHub", or the signed-in user's menu. Renders nothing while
 * the backend's answer is unknown, so it never flashes the wrong state.
 */
export function AuthButton({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const auth = useAuth()
  const toast = useToast()
  if (auth.status !== 'ready') return null

  if (!auth.user) {
    return (
      <Button
        size={size}
        onClick={auth.signIn}
        disabled={!auth.configured}
        title={auth.configured ? undefined : 'GitHub sign-in is not set up on the backend yet'}
      >
        <LogIn aria-hidden="true" />
        Sign in with GitHub
      </Button>
    )
  }

  const { user } = auth
  return (
    <Menu
      label="Account"
      triggerClassName="!h-10 !gap-2 !pl-1 !pr-3 !text-sm"
      trigger={
        <>
          {user.avatarUrl ? (
            <img src={user.avatarUrl} alt="" width={28} height={28} className="size-7 rounded-full" referrerPolicy="no-referrer" />
          ) : (
            <span aria-hidden="true" className="flex size-7 items-center justify-center rounded-full bg-secondary font-medium uppercase">
              {user.login.slice(0, 1)}
            </span>
          )}
          <span className="max-w-32 truncate">{user.login}</span>
        </>
      }
    >
      {(close) => (
        <>
          <p className="truncate px-2 font-medium">{user.name}</p>
          <p className="truncate px-2 pb-2 font-mono text-xs text-muted-foreground">Signed in with GitHub as {user.login}</p>
          {auth.repositoryAccess && (
            <MenuItem
              onClick={() => {
                close()
                navigate(ROUTE_PATHS.repositories)
              }}
            >
              <FolderGit2 aria-hidden="true" />
              Your repositories and access
            </MenuItem>
          )}
          <MenuItem
            onClick={() => {
              close()
              void auth.signOut().then(() => toast('Signed out'))
            }}
          >
            <LogOut aria-hidden="true" />
            Sign out
          </MenuItem>
        </>
      )}
    </Menu>
  )
}
