/** Full auto and proposals stay on the one contract the user selected. Even is not Odd. */
export function contractSelected(selected: string | null | undefined, type: string): boolean {
  return Boolean(selected) && selected === type;
}
