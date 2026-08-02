const V = require('../lib/validate');
let pass=0, fail=0;
const t=(name,got,want)=>{ const ok=got===want; ok?pass++:fail++; if(!ok)console.log(`  FAIL ${name}: got ${got}, want ${want}`); };

// Email
t('valid email', V.validateEmail('a@b.com').ok, true);
t('no @',        V.validateEmail('abc.com').ok, false);
t('no tld',      V.validateEmail('a@b').ok, false);
t('trailing ,',  V.validateEmail('a@b.com,').ok, false);
t('name<addr>',  V.validateEmail('Jane <j@b.com>').ok, false);
t('plus addr',   V.validateEmail('a+u10@b.com').ok, true);
t('uppercased',  V.validateEmail('A@B.COM').value, 'a@b.com');
t('empty req',   V.validateEmail('').ok, false);
t('empty optional ok', V.validateEmail('', {required:false}).ok, true);
t('empty opt',   V.validateEmail('', {required:false}).ok, true);

// Phone
t('10 digit',    V.validatePhone('5551234567').value, '(555) 123-4567');
t('formatted',   V.validatePhone('(555) 123-4567').value, '(555) 123-4567');
t('dashes',      V.validatePhone('555-123-4567').value, '(555) 123-4567');
t('leading 1',   V.validatePhone('15551234567').value, '(555) 123-4567');
t('short accepted',  V.validatePhone('55512').ok, true);
t('short flagged',   V.validatePhone('55512').suspect, true);
t('full not flagged',V.validatePhone('5551234567').suspect, undefined);
t('blank ok',    V.validatePhone('').ok, true);

// Coordinates
t('plain',       V.validateCoordinates('41.535017, -81.461610').value, '41.535017,-81.46161');
t('nospace',     V.validateCoordinates('41.535017,-81.461610').ok, true);
t('maps url',    V.validateCoordinates('https://maps.google.com/@41.535017,-81.461610,15z').value, '41.535017,-81.46161');
t('garbage',     V.validateCoordinates('somewhere in ohio').ok, false);
t('partial num', V.validateCoordinates('41.5abc, -81.4').ok, false);
t('swapped',     V.validateCoordinates('-81.461610, 41.535017').ok, false);
t('out of range',V.validateCoordinates('999, 999').ok, false);
t('blank ok',    V.validateCoordinates('').ok, true);

// Target games
t('valid 10',    V.validateTargetGames(10).value, 10);
t('string 10',   V.validateTargetGames('10').value, 10);
t('abc rejected',V.validateTargetGames('abc').ok, false);
t('zero',        V.validateTargetGames(0).ok, false);
t('999',         V.validateTargetGames(999).ok, false);
t('1.5',         V.validateTargetGames(1.5).ok, false);
t('blank',       V.validateTargetGames('').value, undefined);

console.log(`\nunit: ${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
