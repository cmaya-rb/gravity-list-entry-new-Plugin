// gravity-icon resolves its `name` to a <gravity-icon-{name}> element at
// runtime. In Gravity's lazy build those load on demand; the statically
// bundled custom-elements build only knows icons that were imported, so every
// icon a used component can render internally must be registered here.
import { defineCustomElement as arrowDownOutline } from '@gravity/web-components/dist/custom-elements/gravity-icon-arrow-down-outline';
import { defineCustomElement as arrowRightOutline } from '@gravity/web-components/dist/custom-elements/gravity-icon-arrow-right-outline';
import { defineCustomElement as check } from '@gravity/web-components/dist/custom-elements/gravity-icon-check';
import { defineCustomElement as close } from '@gravity/web-components/dist/custom-elements/gravity-icon-close';
import { defineCustomElement as copy } from '@gravity/web-components/dist/custom-elements/gravity-icon-copy';
import { defineCustomElement as info } from '@gravity/web-components/dist/custom-elements/gravity-icon-info';
import { defineCustomElement as infoMulticolor } from '@gravity/web-components/dist/custom-elements/gravity-icon-info-multicolor';
import { defineCustomElement as warning } from '@gravity/web-components/dist/custom-elements/gravity-icon-warning';
import { defineCustomElement as warningOutline } from '@gravity/web-components/dist/custom-elements/gravity-icon-warning-outline';

export function defineIcons(): void {
  for (const define of [arrowDownOutline, arrowRightOutline, check, close, copy, info, infoMulticolor, warning, warningOutline]) define();
}
