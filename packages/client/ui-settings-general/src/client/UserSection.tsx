/**
 * The Mine section: the signed-in user's identity (from the local server's
 * /whoami, backed by the retained WebIdentity) and the sign-out action.
 * Sign-out navigates to /logout — the server drops the retained identity and
 * the session cookie, then hands the tab to the IdP's RP-initiated logout so
 * the SSO session truly ends (a local-only clear would let the next sign-in
 * silently re-authenticate the same account).
 */
import { useEffect, useState } from 'react'
import { IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './UserSection.module.css'

/** Full component props: section owner share (the close callback) + locale. */
export type UserSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'settings'>

/** Who is at this PC, as the local server's /whoami reports it. */
interface Whoami {
  readonly sub: string
}

/**
 * Render the Mine section content column.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function UserSection({ close, t }: UserSectionComponentProps) {
  const [sub, setSub] = useState<string | undefined>(undefined)
  const [resolved, setResolved] = useState(false)

  useEffect(() => {
    let cancelled = false
    void fetch('/whoami', { cache: 'no-store' })
      .then(async response => (response.ok ? (await response.json() as Whoami).sub : undefined))
      .then((value) => {
        if (!cancelled) {
          setSub(value)
          setResolved(true)
        }
      })
      .catch(() => {
        if (!cancelled) setResolved(true)
      })
    return () => { cancelled = true }
  }, [])

  return (
    <div className={css.section}>
      <div className={css.card}>
        <span className={css.avatar} aria-hidden="true">
          <IconUserOutline16 size={20} />
        </span>
        <div className={css.who}>
          <span className={css.kicker}>{t('user.identity')}</span>
          <span className={css.sub}>{resolved ? (sub ?? t('user.signedOut')) : t('user.loading')}</span>
        </div>
      </div>
      <button
        type="button"
        className={css.signOut}
        disabled={resolved && sub === undefined}
        onClick={() => { close(); window.location.href = '/logout' }}
      >
        {t('user.logout')}
      </button>
      <p className={css.hint}>{t('user.logoutHint')}</p>
    </div>
  )
}
