/**
 * Shell chrome content registered into the shell's trigger/header seats: the
 * trigger row icon + label (figma sidebar foot) and the panel title text.
 * The shell renders the surrounding chrome (button, nav heading row) and
 * reads each entry's `label` option for aria text.
 */
import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { IconSettingsOutline14, IconSettingsOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './chrome.module.css'

/** Trigger content props: the sidebar column state + the standard locale seat. */
export type TriggerContentProps = PropsRuntime<'settings.trigger'> & PropsLocale<'settings'>

/** Header content props: the standard locale seat only. */
export type HeaderContentProps = PropsRuntime<'settings.header'> & PropsLocale<'settings'>

/** User trigger content props: the column state, locale, and the panel open request. */
export type UserTriggerProps = {
  /** Whether the sidebar column renders wide content (false = 56px rail). */
  wide: boolean
  /** The settings-namespace translate seat (only user.* keys are read). */
  t: (key: 'user.identity' | 'user.logout') => string
  /** Request the settings panel to open (lands on the Mine section). */
  onOpen: () => void
}

/** Who is at this PC, as the local server's /whoami reports it. */
interface Whoami {
  readonly sub: string
}

/**
 * Render the identity button (left of the settings trigger in the same foot
 * row): the retained sign-in's sub, resolved from the local server. Hidden
 * while nobody is signed in — the OIDC fence bounces unauthenticated tabs,
 * so the row would not be seen in that state anyway.
 */
export function UserTrigger({ wide, t, onOpen }: UserTriggerProps) {
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

  if (!resolved || sub === undefined) return null

  return (
    <button
      type="button"
      className={clsx(css.userTrigger, !wide && css.userRail)}
      aria-haspopup="dialog"
      title={`${t('user.identity')} ${sub}`}
      onClick={onOpen}
    >
      <IconUserOutline16 size={wide ? 16 : 18} />
      {wide && <span className={css.userLabel}>{sub}</span>}
    </button>
  )
}

/**
 * Render the trigger row content (icon; label only in the wide column).
 * @param props - composed slot props.
 * @returns the trigger content fragment.
 */
export function TriggerContent({ wide, t }: TriggerContentProps) {
  return (
    <>
      {wide ? <IconSettingsOutline16 size={16} /> : <IconSettingsOutline14 size={18} />}
      {wide && <span className={css.triggerLabel}>{t('trigger')}</span>}
    </>
  )
}

/**
 * Render the panel title text.
 * @param props - composed slot props.
 * @returns the title text node.
 */
export function HeaderContent({ t }: HeaderContentProps) {
  return <>{t('title')}</>
}

/** Close-button label text props: the standard locale seat only. */
export type CloseLabelProps = PropsRuntime<'settings.close'> & PropsLocale<'settings'>

/**
 * Render the close button's visually-hidden label text.
 * @param props - composed slot props.
 * @returns the label text node.
 */
export function CloseLabel({ t }: CloseLabelProps) {
  return <>{t('close')}</>
}
