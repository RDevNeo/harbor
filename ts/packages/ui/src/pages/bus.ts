/** A page's exported Slint global (`SettingsBus`...) on the window that hosts the page. */
export function busOf<T>(win: object, name: string): T {
  const bus = Reflect.get(win, name);
  if (typeof bus !== "object" || bus === null) throw new Error(`the window has no ${name}`);
  return bus;
}
