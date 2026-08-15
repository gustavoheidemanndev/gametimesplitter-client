window.overlayFonts = (() => {
  const options = [
    { value: 'Segoe UI, Inter, system-ui, sans-serif', label: 'Segoe UI / Inter', group: 'sans', googleFamily: 'Inter' },
    { value: '"Segoe UI", sans-serif', label: 'Segoe UI', group: 'sans' },
    { value: 'Aptos, "Segoe UI", sans-serif', label: 'Aptos', group: 'sans' },
    { value: 'Calibri, "Segoe UI", sans-serif', label: 'Calibri', group: 'sans' },
    { value: 'Candara, Calibri, sans-serif', label: 'Candara', group: 'sans' },
    { value: 'Corbel, Calibri, sans-serif', label: 'Corbel', group: 'sans' },
    { value: 'Arial, Helvetica, sans-serif', label: 'Arial', group: 'sans' },
    { value: '"Arial Black", Arial, sans-serif', label: 'Arial Black', group: 'sans' },
    { value: 'Verdana, Geneva, sans-serif', label: 'Verdana', group: 'sans' },
    { value: 'Tahoma, Geneva, sans-serif', label: 'Tahoma', group: 'sans' },
    { value: '"Trebuchet MS", Tahoma, sans-serif', label: 'Trebuchet MS', group: 'sans' },
    { value: 'Helvetica, Arial, sans-serif', label: 'Helvetica', group: 'sans' },
    { value: '"Franklin Gothic Medium", Arial, sans-serif', label: 'Franklin Gothic', group: 'sans' },
    { value: '"Century Gothic", CenturyGothic, sans-serif', label: 'Century Gothic', group: 'sans' },
    { value: '"Gill Sans", "Gill Sans MT", Calibri, sans-serif', label: 'Gill Sans', group: 'sans' },
    { value: '"Lucida Sans Unicode", "Lucida Grande", sans-serif', label: 'Lucida Sans', group: 'sans' },
    { value: 'Bahnschrift, "Segoe UI", sans-serif', label: 'Bahnschrift', group: 'sans' },
    { value: '"Segoe Print", "Comic Sans MS", cursive', label: 'Segoe Print', group: 'sans' },
    { value: '"Yu Gothic", "Meiryo", sans-serif', label: 'Yu Gothic', group: 'sans' },
    { value: '"Malgun Gothic", "Segoe UI", sans-serif', label: 'Malgun Gothic', group: 'sans' },
    { value: '"Microsoft YaHei", "Segoe UI", sans-serif', label: 'Microsoft YaHei', group: 'sans' },
    { value: 'Meiryo, "Yu Gothic", sans-serif', label: 'Meiryo', group: 'sans' },
    { value: '"Inter", "Segoe UI", sans-serif', label: 'Inter', group: 'sans', googleFamily: 'Inter' },
    { value: '"Roboto", "Segoe UI", sans-serif', label: 'Roboto', group: 'sans', googleFamily: 'Roboto' },
    { value: '"Open Sans", "Segoe UI", sans-serif', label: 'Open Sans', group: 'sans', googleFamily: 'Open Sans' },
    { value: '"Lato", "Segoe UI", sans-serif', label: 'Lato', group: 'sans', googleFamily: 'Lato' },
    { value: '"Montserrat", "Segoe UI", sans-serif', label: 'Montserrat', group: 'sans', googleFamily: 'Montserrat' },
    { value: '"Poppins", "Segoe UI", sans-serif', label: 'Poppins', group: 'sans', googleFamily: 'Poppins' },
    { value: '"Nunito", "Segoe UI", sans-serif', label: 'Nunito', group: 'sans', googleFamily: 'Nunito' },
    { value: '"Nunito Sans", "Segoe UI", sans-serif', label: 'Nunito Sans', group: 'sans', googleFamily: 'Nunito Sans' },
    { value: '"Source Sans 3", "Segoe UI", sans-serif', label: 'Source Sans 3', group: 'sans', googleFamily: 'Source Sans 3' },
    { value: '"IBM Plex Sans", "Segoe UI", sans-serif', label: 'IBM Plex Sans', group: 'sans', googleFamily: 'IBM Plex Sans' },
    { value: '"Noto Sans", "Segoe UI", sans-serif', label: 'Noto Sans', group: 'sans', googleFamily: 'Noto Sans' },
    { value: '"Ubuntu", "Segoe UI", sans-serif', label: 'Ubuntu', group: 'sans', googleFamily: 'Ubuntu' },
    { value: '"Raleway", "Segoe UI", sans-serif', label: 'Raleway', group: 'sans', googleFamily: 'Raleway' },
    { value: '"PT Sans", "Segoe UI", sans-serif', label: 'PT Sans', group: 'sans', googleFamily: 'PT Sans' },
    { value: '"Fira Sans", "Segoe UI", sans-serif', label: 'Fira Sans', group: 'sans', googleFamily: 'Fira Sans' },
    { value: '"Outfit", "Segoe UI", sans-serif', label: 'Outfit', group: 'sans', googleFamily: 'Outfit' },
    { value: '"Barlow", "Segoe UI", sans-serif', label: 'Barlow', group: 'sans', googleFamily: 'Barlow' },
    { value: '"Titillium Web", "Segoe UI", sans-serif', label: 'Titillium Web', group: 'sans', googleFamily: 'Titillium Web' },
    { value: '"Josefin Sans", "Segoe UI", sans-serif', label: 'Josefin Sans', group: 'sans', googleFamily: 'Josefin Sans' },
    { value: '"Quicksand", "Segoe UI", sans-serif', label: 'Quicksand', group: 'sans', googleFamily: 'Quicksand' },
    { value: '"Comfortaa", "Segoe UI", sans-serif', label: 'Comfortaa', group: 'sans', googleFamily: 'Comfortaa' },
    { value: '"Rubik", "Segoe UI", sans-serif', label: 'Rubik', group: 'sans', googleFamily: 'Rubik' },
    { value: '"Work Sans", "Segoe UI", sans-serif', label: 'Work Sans', group: 'sans', googleFamily: 'Work Sans' },
    { value: '"DM Sans", "Segoe UI", sans-serif', label: 'DM Sans', group: 'sans', googleFamily: 'DM Sans' },
    { value: '"Manrope", "Segoe UI", sans-serif', label: 'Manrope', group: 'sans', googleFamily: 'Manrope' },
    { value: '"Kanit", "Segoe UI", sans-serif', label: 'Kanit', group: 'sans', googleFamily: 'Kanit' },
    { value: '"Archivo", "Segoe UI", sans-serif', label: 'Archivo', group: 'sans', googleFamily: 'Archivo' },
    { value: '"Space Grotesk", "Segoe UI", sans-serif', label: 'Space Grotesk', group: 'sans', googleFamily: 'Space Grotesk' },
    { value: '"Plus Jakarta Sans", "Segoe UI", sans-serif', label: 'Plus Jakarta Sans', group: 'sans', googleFamily: 'Plus Jakarta Sans' },
    { value: '"Figtree", "Segoe UI", sans-serif', label: 'Figtree', group: 'sans', googleFamily: 'Figtree' },
    { value: 'system-ui, sans-serif', label: 'System UI', group: 'sans' },
    { value: 'sans-serif', label: 'Generic Sans', group: 'sans' },

    { value: 'Georgia, "Times New Roman", serif', label: 'Georgia', group: 'serif' },
    { value: '"Times New Roman", Times, serif', label: 'Times New Roman', group: 'serif' },
    { value: 'Cambria, Georgia, serif', label: 'Cambria', group: 'serif' },
    { value: '"Palatino Linotype", Palatino, serif', label: 'Palatino', group: 'serif' },
    { value: 'Garamond, Georgia, serif', label: 'Garamond', group: 'serif' },
    { value: 'Constantia, Georgia, serif', label: 'Constantia', group: 'serif' },
    { value: '"Book Antiqua", Palatino, serif', label: 'Book Antiqua', group: 'serif' },
    { value: '"Sitka Text", Georgia, serif', label: 'Sitka Text', group: 'serif' },
    { value: '"Merriweather", Georgia, serif', label: 'Merriweather', group: 'serif', googleFamily: 'Merriweather' },
    { value: '"Playfair Display", Georgia, serif', label: 'Playfair Display', group: 'serif', googleFamily: 'Playfair Display' },
    { value: '"Libre Baskerville", Georgia, serif', label: 'Libre Baskerville', group: 'serif', googleFamily: 'Libre Baskerville' },
    { value: '"Crimson Text", Georgia, serif', label: 'Crimson Text', group: 'serif', googleFamily: 'Crimson Text' },
    { value: '"Lora", Georgia, serif', label: 'Lora', group: 'serif', googleFamily: 'Lora' },
    { value: '"PT Serif", Georgia, serif', label: 'PT Serif', group: 'serif', googleFamily: 'PT Serif' },
    { value: '"Noto Serif", Georgia, serif', label: 'Noto Serif', group: 'serif', googleFamily: 'Noto Serif' },
    { value: '"Source Serif 4", Georgia, serif', label: 'Source Serif 4', group: 'serif', googleFamily: 'Source Serif 4' },
    { value: 'serif', label: 'Generic Serif', group: 'serif' },

    { value: 'Consolas, "Cascadia Mono", "Courier New", monospace', label: 'Consolas / Cascadia Mono', group: 'mono' },
    { value: 'Consolas, monospace', label: 'Consolas', group: 'mono' },
    { value: '"Cascadia Mono", Consolas, monospace', label: 'Cascadia Mono', group: 'mono' },
    { value: '"Cascadia Code", Consolas, monospace', label: 'Cascadia Code', group: 'mono' },
    { value: '"Courier New", Courier, monospace', label: 'Courier New', group: 'mono' },
    { value: '"Lucida Console", Monaco, monospace', label: 'Lucida Console', group: 'mono' },
    { value: '"Lucida Sans Typewriter", "Lucida Console", monospace', label: 'Lucida Typewriter', group: 'mono' },
    { value: '"Roboto Mono", Consolas, monospace', label: 'Roboto Mono', group: 'mono', googleFamily: 'Roboto Mono' },
    { value: '"Fira Code", Consolas, monospace', label: 'Fira Code', group: 'mono', googleFamily: 'Fira Code' },
    { value: '"JetBrains Mono", Consolas, monospace', label: 'JetBrains Mono', group: 'mono', googleFamily: 'JetBrains Mono' },
    { value: '"Source Code Pro", Consolas, monospace', label: 'Source Code Pro', group: 'mono', googleFamily: 'Source Code Pro' },
    { value: '"IBM Plex Mono", Consolas, monospace', label: 'IBM Plex Mono', group: 'mono', googleFamily: 'IBM Plex Mono' },
    { value: '"Share Tech Mono", Consolas, monospace', label: 'Share Tech Mono', group: 'mono', googleFamily: 'Share Tech Mono' },
    { value: '"Inconsolata", Consolas, monospace', label: 'Inconsolata', group: 'mono', googleFamily: 'Inconsolata' },
    { value: '"Space Mono", Consolas, monospace', label: 'Space Mono', group: 'mono', googleFamily: 'Space Mono' },
    { value: '"Ubuntu Mono", Consolas, monospace', label: 'Ubuntu Mono', group: 'mono', googleFamily: 'Ubuntu Mono' },
    { value: '"Overpass Mono", Consolas, monospace', label: 'Overpass Mono', group: 'mono', googleFamily: 'Overpass Mono' },
    { value: '"Red Hat Mono", Consolas, monospace', label: 'Red Hat Mono', group: 'mono', googleFamily: 'Red Hat Mono' },
    { value: '"Chivo Mono", Consolas, monospace', label: 'Chivo Mono', group: 'mono', googleFamily: 'Chivo Mono' },
    { value: '"Anonymous Pro", Consolas, monospace', label: 'Anonymous Pro', group: 'mono', googleFamily: 'Anonymous Pro' },
    { value: '"Cousine", Consolas, monospace', label: 'Cousine', group: 'mono', googleFamily: 'Cousine' },
    { value: '"Spline Sans Mono", Consolas, monospace', label: 'Spline Sans Mono', group: 'mono', googleFamily: 'Spline Sans Mono' },
    { value: '"Martian Mono", Consolas, monospace', label: 'Martian Mono', group: 'mono', googleFamily: 'Martian Mono' },
    { value: '"Fragment Mono", Consolas, monospace', label: 'Fragment Mono', group: 'mono', googleFamily: 'Fragment Mono' },
    { value: '"Cutive Mono", Consolas, monospace', label: 'Cutive Mono', group: 'mono', googleFamily: 'Cutive Mono' },
    { value: '"Oxygen Mono", Consolas, monospace', label: 'Oxygen Mono', group: 'mono', googleFamily: 'Oxygen Mono' },
    { value: 'monospace', label: 'Generic Mono', group: 'mono' },

    { value: 'Impact, Haettenschweiler, sans-serif', label: 'Impact', group: 'display' },
    { value: '"Comic Sans MS", "Comic Sans", cursive', label: 'Comic Sans MS', group: 'display' },
    { value: '"Oswald", Impact, sans-serif', label: 'Oswald', group: 'display', googleFamily: 'Oswald' },
    { value: '"Exo 2", "Segoe UI", sans-serif', label: 'Exo 2', group: 'display', googleFamily: 'Exo 2' },
    { value: '"Rajdhani", "Segoe UI", sans-serif', label: 'Rajdhani', group: 'display', googleFamily: 'Rajdhani' },
    { value: '"Orbitron", sans-serif', label: 'Orbitron', group: 'display', googleFamily: 'Orbitron' },
    { value: '"Russo One", Impact, sans-serif', label: 'Russo One', group: 'display', googleFamily: 'Russo One' },
    { value: '"Audiowide", sans-serif', label: 'Audiowide', group: 'display', googleFamily: 'Audiowide' },
    { value: '"Chakra Petch", "Segoe UI", sans-serif', label: 'Chakra Petch', group: 'display', googleFamily: 'Chakra Petch' },
    { value: '"Teko", Impact, sans-serif', label: 'Teko', group: 'display', googleFamily: 'Teko' },
    { value: '"Anton", Impact, sans-serif', label: 'Anton', group: 'display', googleFamily: 'Anton' },
    { value: '"Bebas Neue", Impact, sans-serif', label: 'Bebas Neue', group: 'display', googleFamily: 'Bebas Neue' },
    { value: '"Saira Condensed", "Segoe UI", sans-serif', label: 'Saira Condensed', group: 'display', googleFamily: 'Saira Condensed' },
    { value: '"Quantico", "Segoe UI", sans-serif', label: 'Quantico', group: 'display', googleFamily: 'Quantico' },
    { value: '"Oxanium", "Segoe UI", sans-serif', label: 'Oxanium', group: 'display', googleFamily: 'Oxanium' },
    { value: '"Press Start 2P", cursive', label: 'Press Start 2P', group: 'display', googleFamily: 'Press Start 2P' },
    { value: '"VT323", monospace', label: 'VT323', group: 'display', googleFamily: 'VT323' },
    { value: '"Silkscreen", cursive', label: 'Silkscreen', group: 'display', googleFamily: 'Silkscreen' },
    { value: '"Michroma", sans-serif', label: 'Michroma', group: 'display', googleFamily: 'Michroma' },
    { value: '"Electrolize", sans-serif', label: 'Electrolize', group: 'display', googleFamily: 'Electrolize' },
    { value: '"Black Ops One", Impact, sans-serif', label: 'Black Ops One', group: 'display', googleFamily: 'Black Ops One' },
    { value: '"Bungee", Impact, sans-serif', label: 'Bungee', group: 'display', googleFamily: 'Bungee' },
    { value: '"Bangers", Impact, cursive', label: 'Bangers', group: 'display', googleFamily: 'Bangers' },
    { value: '"Aldrich", sans-serif', label: 'Aldrich', group: 'display', googleFamily: 'Aldrich' },
    { value: '"Syncopate", sans-serif', label: 'Syncopate', group: 'display', googleFamily: 'Syncopate' },
  ];
  const groups = ['sans', 'serif', 'mono', 'display'];

  const allGoogleFamilies = () => [...new Set(options.map((option) => option.googleFamily).filter(Boolean))];
  const googleFamiliesForStacks = (stacks) => {
    const families = new Set();
    (stacks || []).forEach((stack) => {
      const exact = options.find((option) => option.value === stack && option.googleFamily);
      if (exact) families.add(exact.googleFamily);
      options.forEach((option) => {
        if (option.googleFamily && stack && stack.includes(option.googleFamily)) families.add(option.googleFamily);
      });
    });
    return [...families];
  };
  const stylesheetId = (family) => `overlay-web-fonts-${String(family).replace(/[^a-zA-Z0-9+-]/g, '')}`;
  const appendStylesheet = (family) => {
    if (!family) return;
    const id = stylesheetId(family);
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@0,400;0,600;0,700;0,800;1,400;1,700&display=swap`;
    link.addEventListener('error', () => {
      link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}&display=swap`;
    });
    document.head.append(link);
  };
  const ensure = (stacks) => {
    const families = stacks && stacks.length ? googleFamiliesForStacks(stacks) : allGoogleFamilies();
    families.forEach(appendStylesheet);
  };

  return { options, groups, ensure };
})();
