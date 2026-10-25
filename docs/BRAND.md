# Bridge brand assets

Imported byte-for-byte from the app repository branch `brand/logo-final`,
commit `12cef5de5b459b0b5e09b706b2670f397c3f1425`, `brand/logo/`.
The final crown badge uses `#6A4CEA`; the wordmark is outlined Outfit 800.
`src/brand-assets.json` embeds these SVGs as data URLs so the logos on the
dashboard, settings and browser setup need no font or image download.
The dark lockup is white lettering for a dark ground; the light lockup is
dark lettering for a light ground. Native installer/tray icons are separate
from this runtime-only Windows payload and await the full package release.

| Source asset | SHA-256 |
|---|---|
| empir3-mark.svg | `5d13932feef5ca4875d486991798f6ab954857f6c90f430aef0f9d1fc6eaef8e` |
| empir3-lockup-dark.svg | `7d237fd11bc58caf91bd95fc25ef8842838cf4e34832719e0cbb5c38099b608b` |
| empir3-lockup-light.svg | `55cc1023f6f0ac606a7bea352358c3378843f45ce332396ab1c51497919ca6f1` |
