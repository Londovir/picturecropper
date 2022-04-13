import { Component, ViewChild } from '@angular/core';

import { fromEvent, Subscription, TeardownLogic } from 'rxjs';

import { DragDirective } from './drag.directive';

@Component({
    selector: 'app-root',
    templateUrl: './app.component.html',
    styleUrls: ['./app.component.scss'],
})
export class AppComponent {
    @ViewChild(DragDirective) dragger: DragDirective | null = null;

    title = 'picturecropper';

    private _subrelease = new Subscription();
    set subrelease(sub: TeardownLogic) {
        this._subrelease.add(sub);
    }

    constructor() {}

    GetCrop() {
        if (this.dragger) {
            const crop = this.dragger.GetCroppedRegion();

            const srcImg = document.querySelector('#srcImage') as HTMLImageElement;
            const canv = document.querySelector('#destCanvas') as HTMLCanvasElement;
            if (crop && srcImg && canv) {
                const imgWidth = srcImg.naturalWidth;
                const imgHeight = srcImg.naturalHeight;

                const cxt = canv.getContext('2d');
                cxt?.drawImage(
                    srcImg,
                    Math.floor(crop.x1 * imgWidth),
                    Math.floor(crop.y1 * imgHeight),
                    Math.floor((crop.x2 - crop.x1) * imgWidth),
                    Math.floor((crop.y2 - crop.y1) * imgHeight),
                    0,
                    0,
                    canv.width,
                    canv.height
                );

                const anchor = document.querySelector('#downloadLink') as HTMLAnchorElement;
                if (anchor) {
                    anchor.download = 'test.png';
                    anchor.href = canv.toDataURL();
                    // anchor.click();
                }
            }
        }
    }
}
