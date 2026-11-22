import {
  type JSX,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react"

import {
  closeWindow,
  installedCli,
  openLink,
  showWindow,
  winvm,
} from "../../backend"
import { Button } from "../../components/Button"
import { Icon } from "../../components/Icon"
import { t } from "../../i18n"
import {
  type AboutDetails,
  CONTRIBUTORS,
  isDevelopment,
  machineCount,
  SOURCE,
  UNKNOWN,
  versionDetails,
  WEBSITE,
} from "./details"

function useAboutDetails(): AboutDetails {
  const [details, setDetails] = useState<AboutDetails>(UNKNOWN)
  useEffect(() => {
    let gone = false
    const merge = (part: Partial<AboutDetails>): void => {
      if (!gone) setDetails((d) => ({ ...d, ...part }))
    }
    const read = (): void => {
      winvm("version", "--json")
        .then((out) => {
          merge(versionDetails(out))
        })
        .catch(() => undefined)
      winvm("ls", "--json")
        .then((out) => {
          merge({ machines: machineCount(out) })
        })
        .catch(() => undefined)
      installedCli()
        .then((path) => {
          merge({ cli: { path } })
        })
        .catch(() => {
          merge({ cli: null })
        })
    }
    read()
    window.addEventListener("focus", read)
    return () => {
      gone = true
      window.removeEventListener("focus", read)
    }
  }, [])
  return details
}

function ExternalLink({
  url,
  children,
}: {
  readonly url: string
  readonly children: ReactNode
}): JSX.Element {
  const follow = (e: MouseEvent<HTMLAnchorElement>): void => {
    e.preventDefault()
    openLink(url).catch(() => undefined)
  }
  return (
    <a className="about__link" href={url} onClick={follow}>
      {children}
    </a>
  )
}

function Detail({
  label,
  value,
  mono = false,
}: {
  readonly label: string
  readonly value: string | null
  readonly mono?: boolean
}): JSX.Element {
  return (
    <div className="about__detail">
      <dt>{label}</dt>
      <dd className={mono && value !== null ? "about__mono" : undefined}>
        {value ?? t("about.unknown")}
      </dd>
    </div>
  )
}

export function About({ version }: { readonly version: string }): JSX.Element {
  const details = useAboutDetails()
  useEffect(() => {
    showWindow()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeWindow()
    }
    const quiet = (e: globalThis.MouseEvent): void => {
      e.preventDefault()
    }
    document.addEventListener("keydown", onKey)
    window.addEventListener("contextmenu", quiet)
    return () => {
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("contextmenu", quiet)
    }
  }, [])
  return (
    <section
      className="about"
      role="dialog"
      aria-labelledby="about-title"
      data-tauri-drag-region="deep"
    >
      <Button
        variant="ghost"
        className="btn--icon about__close"
        aria-label={t("about.close")}
        onClick={closeWindow}
      >
        <Icon name="cross" />
      </Button>
      <div className="about__mark" aria-hidden="true" />
      <div className="about__copy">
        <h1 className="about__title" id="about-title">
          {t("about.name")}
        </h1>
        <p className="about__version">
          {isDevelopment(version)
            ? t("about.development")
            : t("about.version", { version })}
        </p>
        <div className="about__links">
          <ExternalLink url={WEBSITE}>{t("about.website")}</ExternalLink>
          <ExternalLink url={SOURCE}>{t("about.source")}</ExternalLink>
        </div>
        <dl className="about__details">
          <Detail label={t("about.runtime")} value={details.runtime} />
          <Detail
            label={t("about.cli")}
            value={
              details.cli === null
                ? null
                : (details.cli.path ?? t("about.cli.none"))
            }
            mono={details.cli !== null && details.cli.path !== null}
          />
          <Detail label={t("about.machines")} value={details.machines} />
          <Detail label={t("about.build")} value={details.build} mono />
        </dl>
        <div className="about__contributors">
          <span className="about__label">{t("about.contributors")}</span>
          <div className="about__links">
            {CONTRIBUTORS.map((c) => (
              <ExternalLink key={c.name} url={c.url}>
                {c.name}
              </ExternalLink>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}
