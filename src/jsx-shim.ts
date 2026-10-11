// Artifact builds load React's UMD build from a CDN, which has no
// react/jsx-runtime entry. The compiled JSX calls these instead.
import * as React from "react";

type Props = Record<string, unknown> & { children?: unknown };

export const Fragment = React.Fragment;

export function jsx(type: React.ElementType, props: Props, key?: React.Key) {
  const { children, ...rest } = props;
  if (key !== undefined) (rest as { key?: React.Key }).key = key;
  return children === undefined ? React.createElement(type, rest) : React.createElement(type, rest, children as React.ReactNode);
}

// Static child lists: spread them so React doesn't ask for keys.
export function jsxs(type: React.ElementType, props: Props, key?: React.Key) {
  const { children, ...rest } = props;
  if (key !== undefined) (rest as { key?: React.Key }).key = key;
  return React.createElement(type, rest, ...((children as React.ReactNode[]) ?? []));
}
