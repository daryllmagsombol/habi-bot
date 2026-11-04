import type { ReactNode, SVGProps } from 'react';

/**
 * Authored icons, one geometry system: a 20-unit box, 1.5 stroke, round caps,
 * no fills. Icons are decorative by default because every icon-only control in
 * the library carries its own accessible name; pass `title` only when an icon
 * is the sole label of a non-interactive element.
 */
export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  readonly size?: number;
  readonly title?: string;
}

function Icon({ size = 16, title, children, ...rest }: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      {...rest}
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title === undefined ? true : undefined}
      role={title === undefined ? undefined : 'img'}
      focusable="false"
    >
      {title === undefined ? null : <title>{title}</title>}
      {children}
    </svg>
  );
}

export function ChevronRightIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M7.5 4.5 13 10l-5.5 5.5" />
    </Icon>
  );
}

export function ChevronLeftIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M12.5 4.5 7 10l5.5 5.5" />
    </Icon>
  );
}

export function ArrowUpIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M10 16V4M5 9l5-5 5 5" />
    </Icon>
  );
}

export function CloseIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M5 5l10 10M15 5 5 15" />
    </Icon>
  );
}

export function PlusIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M10 4v12M4 10h12" />
    </Icon>
  );
}

export function MenuIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M3 5.5h14M3 10h14M3 14.5h9" />
    </Icon>
  );
}

export function PaperclipIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M13.4 6.6l-5 5a2.1 2.1 0 0 0 3 3l5.2-5.2a3.6 3.6 0 0 0-5.1-5.1l-5.2 5.2a5 5 0 0 0 7.1 7.1l1.9-1.9" />
    </Icon>
  );
}

export function DocumentIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M5 2.75h6.5L15 6.25v11H5z" />
      <path d="M11.5 2.75v3.5H15M7.75 9.25h4.5M7.75 12h4.5M7.75 14.75h2.75" />
    </Icon>
  );
}

/** Context: two gates on a rail — the visual metaphor for dual approval. */
export function GatesIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M4 6h12M4 14h12" />
      <circle cx="7.5" cy="6" r="1.9" />
      <circle cx="12.5" cy="14" r="1.9" />
    </Icon>
  );
}

export function CheckIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M4.5 10.5 8 14l7.5-8" />
    </Icon>
  );
}

export function ArrowRightIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M4 10h12M11 5l5 5-5 5" />
    </Icon>
  );
}

export function ArrowUpRightIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M6 14 14 6M7.5 6H14v6.5" />
    </Icon>
  );
}

export function AlertIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M10 3.5 17 16H3z" />
      <path d="M10 8v3.5M10 13.75h.01" />
    </Icon>
  );
}

export function ThreadIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M3.5 5.5h9M3.5 10h13M3.5 14.5h6.5" />
    </Icon>
  );
}

export function SunIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <circle cx="10" cy="10" r="3.5" />
      <path d="M10 2.5v1.8M10 15.7v1.8M2.5 10h1.8M15.7 10h1.8M4.7 4.7l1.3 1.3M14 14l1.3 1.3M15.3 4.7 14 6M6 14l-1.3 1.3" />
    </Icon>
  );
}

export function MoonIcon(props: Readonly<IconProps>) {
  return (
    <Icon {...props}>
      <path d="M16.2 12.4A6.6 6.6 0 0 1 7.6 3.8a6.8 6.8 0 1 0 8.6 8.6Z" />
    </Icon>
  );
}
