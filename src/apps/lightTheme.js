/**
 * Keeps a window on Foundry's light theme whatever the user's colour scheme is.
 * Foundry tags each window with `themed theme-dark` when the dark scheme is on,
 * which repaints the window body; the module is only designed for parchment.
 */
export const LightThemeMixin = (Base) =>
  class extends Base {
    async _renderFrame(options) {
      const frame = await super._renderFrame(options);
      forceLightTheme(frame);
      return frame;
    }

    _onRender(context, options) {
      super._onRender(context, options);
      forceLightTheme(this.element);
    }
  };

export const forceLightTheme = (element) => {
  if (!element) return;
  for (const el of [element, ...element.querySelectorAll('.theme-dark')]) {
    el.classList.remove('theme-dark');
    el.classList.add('themed', 'theme-light');
  }
};
