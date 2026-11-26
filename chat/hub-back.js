// A hub's bare address (bridge/screens.js): Google's sign-in comes back here (#g=… photos, #gc=… calendars, #g-no), and the
// settings page that started it takes it from there; anything else is the home screen.
location.replace(/^#(g=|gc=|g-no$)/.test(location.hash) ? '/hub/' + location.hash : '/screen/');
