import {
    AfterContentInit,
    ContentChild,
    ContentChildren,
    Directive,
    ElementRef,
    EventEmitter,
    Input,
    OnDestroy,
    Output,
    QueryList,
    ViewChildren,
} from '@angular/core';

import {
    filter,
    fromEvent,
    map,
    mergeMap,
    Observable,
    startWith,
    Subscription,
    switchMap,
    switchMapTo,
    take,
    takeUntil,
    tap,
    TeardownLogic,
} from 'rxjs';

@Directive({
    selector: '[appDragHandle]',
})
export class DragHandleDirective {
    @Input() appDragHandle = '';

    constructor(public ele: ElementRef<HTMLElement>) {}
}

@Directive({
    selector: '[appDragShadow]',
})
export class DragShadowDirective {
    @Input() appDragShadow = '';

    constructor(public ele: ElementRef<HTMLElement>) {}
}

@Directive({
    selector: '[appDragFrame]',
})
export class DragFrameDirective implements AfterContentInit, OnDestroy {
    private _subrelease = new Subscription();
    set subrelease(sub: TeardownLogic) {
        this._subrelease.add(sub);
    }

    // The frame communicates with its handles, which are child directives of the drag frame directive.
    @ContentChildren(DragHandleDirective) set dragHandles(_han: QueryList<DragHandleDirective> | null) {
        this._dragHandles = _han;
    }
    get DragHandles() {
        return (this._dragHandles?.map((h) => h) || []) as DragHandleDirective[];
    }
    private _dragHandles: QueryList<DragHandleDirective> | null = null;

    @Input() set appDragFrameParent(_fp: HTMLElement | null) {
        this._appDragFrameParent = _fp;

        if (this._appDragFrameParent) {
            const parEle = this._appDragFrameParent as HTMLElement | null;

            if (!parEle) {
                this.ContainerBox = {
                    x1: 0,
                    y1: 0,
                    x2: 0,
                    y2: 0,
                    width: 0,
                    height: 0,
                    centerx: 0,
                    centery: 0,
                    topBorder: 0,
                    leftBorder: 0,
                    rightBorder: 0,
                    bottomBorder: 0,
                };
            } else {
                const containerCoords = parEle.getBoundingClientRect();
                const containerStyle = getComputedStyle(parEle);

                this.ContainerBox = {
                    x1: containerCoords.left,
                    y1: containerCoords.top,
                    x2: containerCoords.right,
                    y2: containerCoords.bottom,
                    width: containerCoords.right - containerCoords.left,
                    height: containerCoords.bottom - containerCoords.top,
                    centerx: (containerCoords.left + containerCoords.right) / 2,
                    centery: (containerCoords.top + containerCoords.bottom) / 2,
                    topBorder: parseFloat(containerStyle.getPropertyValue('border-top-width')),
                    leftBorder: parseFloat(containerStyle.getPropertyValue('border-left-width')),
                    rightBorder: parseFloat(containerStyle.getPropertyValue('border-right-width')),
                    bottomBorder: parseFloat(containerStyle.getPropertyValue('border-bottom-width')),
                };
            }
        }
    }
    get appDragFrameParent() {
        return this._appDragFrameParent as HTMLElement | null;
    }
    private _appDragFrameParent: HTMLElement | null = null;

    ActiveDragSub: Subscription | null = null;
    ActiveHandle: DragHandleDirective | null = null;
    @Input() appDragMinWidth: number = 50; // Not implemented yet
    @Input() appDragMinHeight: number = 100; // Not implemented yet
    @Input() appDragAspectRatio: string = '1:1';
    ContainerBox: FramePosition = {
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 0,
        width: 0,
        height: 0,
        centerx: 0,
        centery: 0,
        topBorder: 0,
        leftBorder: 0,
        rightBorder: 0,
        bottomBorder: 0,
    };
    FrameBox: FramePosition;
    HandleOffset: HandleOffset | null = null;

    // Properties used in the drag/resize operation.
    private rectangle: Rectangle;

    // Helper shortcuts
    private CLAMP = (x: number, mn: number, mx: number) => Math.min(Math.max(x, mn), mx);
    private SIGNED_ROUND = (x: number) => Math.floor(x + 0.5);
    private FEQUAL = (x: number, y: number) => Math.abs(x - y) < 1e-4;
    private FZERO = (x: number) => Math.abs(x) < 1e-4;

    @Output() appDragFrameResize = new EventEmitter<SimpleRectangle>();
    @Output() appDragFrameBegin = new EventEmitter<DragInitiateEventInfo>();

    constructor(public ele: ElementRef<HTMLElement>) {
        const frameCoords = this.ele.nativeElement.getBoundingClientRect();
        const frameStyle = getComputedStyle(this.ele.nativeElement);

        this.FrameBox = {
            x1: frameCoords.left,
            y1: frameCoords.top,
            x2: frameCoords.right,
            y2: frameCoords.bottom,
            width: frameCoords.right - frameCoords.left,
            height: frameCoords.bottom - frameCoords.top,
            centerx: (frameCoords.left + frameCoords.right) / 2,
            centery: (frameCoords.top + frameCoords.bottom) / 2,
            topBorder: parseFloat(frameStyle.getPropertyValue('border-top-width')),
            leftBorder: parseFloat(frameStyle.getPropertyValue('border-left-width')),
            rightBorder: parseFloat(frameStyle.getPropertyValue('border-right-width')),
            bottomBorder: parseFloat(frameStyle.getPropertyValue('border-bottom-width')),
        };

        this.rectangle = this.InitializeRectangle();

        // Determine if we are using an aspect ratio for this operation (assuming it will be a resize, at least).
        this.rectangle.fixed_rule_active = !!this.appDragAspectRatio;
        this.rectangle.fixed_rule = FixedRule.ASPECT;
        if (this.rectangle.fixed_rule_active) {
            // We need to parse out the aspect values so we can set the aspect ratio. If the format is invalid, we assume an error and just skip using an aspect ratio.
            const ratioParts = this.appDragAspectRatio.match(/^(\d+(?:\.\d*)?):(\d+(?:\.\d*)?)$/);
            if (ratioParts == null || ratioParts.length < 3) {
                // Invalid. Turn off aspect locking.
                this.rectangle.fixed_rule_active = false;
            } else {
                this.rectangle.aspect_numerator = Number.parseFloat(ratioParts[1]);
                this.rectangle.aspect_denominator = Number.parseFloat(ratioParts[2]);
                if (this.FZERO(this.rectangle.aspect_numerator) || this.FZERO(this.rectangle.aspect_denominator)) {
                    this.rectangle.fixed_rule_active = false;
                }
            }
        }
        if (!this.rectangle.fixed_rule_active) {
            [this.rectangle.aspect_numerator, this.rectangle.aspect_denominator] = [0, 0];
        }
    }

    ngAfterContentInit(): void {
        this.subrelease = this._dragHandles?.changes.pipe(startWith(0)).subscribe((hans) => {
            // If we are currently in a drag operation, cancel it.
            //  self.CancelDrag();

            // Release all subscriptions in place right now for the drag operations.
            this.ActiveDragSub?.unsubscribe();
            this.ActiveDragSub = null;

            // Set up new drag handlers as needed for the new drag handles discovered.
            this.SetupDragHandles();
        });
    }

    ngOnDestroy(): void {
        this._subrelease?.unsubscribe();
    }

    // #region Apply Proper Aspect Ratio

    ApplyProperAspectRatio(aspect: number, clamped_sides: number | null) {
        let current_w: number;
        let current_h: number;
        let current_aspect: number;
        let side_to_resize: SideToResize = SideToResize.SIDE_TO_RESIZE_NONE;

        current_w = this.rectangle.x2 - this.rectangle.x1;
        current_h = this.rectangle.y2 - this.rectangle.y1;

        current_aspect = current_w / current_h;

        /* Do we have to do anything? */
        if (this.FEQUAL(current_aspect, aspect)) return;

        if (clamped_sides == null) clamped_sides = ClampedSide.CLAMPED_NONE;

        if (current_aspect > aspect) {
            /* We can safely pick LEFT or RIGHT, since using those sides
             * will make the rectangle smaller, so we don't need to check
             * for clamped_sides. We may only use TOP and BOTTOM if not
             * those sides have been clamped, since using them will make the
             * rectangle bigger.
             */
            switch (this.rectangle.function) {
                case ResizingFunction.RESIZING_UPPER_LEFT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_TOP)) side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
                    break;

                case ResizingFunction.RESIZING_UPPER_RIGHT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_TOP)) side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
                    break;

                case ResizingFunction.RESIZING_LOWER_LEFT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_BOTTOM)) side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
                    break;

                case ResizingFunction.RESIZING_LOWER_RIGHT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_BOTTOM)) side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
                    break;

                case ResizingFunction.RESIZING_LEFT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_TOP) && !(clamped_sides & ClampedSide.CLAMPED_BOTTOM))
                        side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP_AND_BOTTOM_SYMMETRICALLY;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
                    break;

                case ResizingFunction.RESIZING_RIGHT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_TOP) && !(clamped_sides & ClampedSide.CLAMPED_BOTTOM))
                        side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP_AND_BOTTOM_SYMMETRICALLY;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
                    break;

                case ResizingFunction.RESIZING_BOTTOM:
                case ResizingFunction.RESIZING_TOP:
                    side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT_AND_RIGHT_SYMMETRICALLY;
                    break;

                case ResizingFunction.MOVING:
                default:
                    if (!(clamped_sides & ClampedSide.CLAMPED_BOTTOM)) side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
                    else if (!(clamped_sides & ClampedSide.CLAMPED_RIGHT)) side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
                    else if (!(clamped_sides & ClampedSide.CLAMPED_TOP)) side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
                    else if (!(clamped_sides & ClampedSide.CLAMPED_LEFT)) side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
                    break;
            }
        } /* (current_aspect < aspect) */ else {
            /* We can safely pick TOP or BOTTOM, since using those sides
             * will make the rectangle smaller, so we don't need to check
             * for clamped_sides. We may only use LEFT and RIGHT if not
             * those sides have been clamped, since using them will make the
             * rectangle bigger.
             */
            switch (this.rectangle.function) {
                case ResizingFunction.RESIZING_UPPER_LEFT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_LEFT)) side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
                    break;

                case ResizingFunction.RESIZING_UPPER_RIGHT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_RIGHT)) side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
                    break;

                case ResizingFunction.RESIZING_LOWER_LEFT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_LEFT)) side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
                    break;

                case ResizingFunction.RESIZING_LOWER_RIGHT:
                    if (!(clamped_sides & ClampedSide.CLAMPED_RIGHT)) side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
                    break;

                case ResizingFunction.RESIZING_TOP:
                    if (!(clamped_sides & ClampedSide.CLAMPED_LEFT) && !(clamped_sides & ClampedSide.CLAMPED_RIGHT))
                        side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT_AND_RIGHT_SYMMETRICALLY;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
                    break;

                case ResizingFunction.RESIZING_BOTTOM:
                    if (!(clamped_sides & ClampedSide.CLAMPED_LEFT) && !(clamped_sides & ClampedSide.CLAMPED_RIGHT))
                        side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT_AND_RIGHT_SYMMETRICALLY;
                    else side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
                    break;

                case ResizingFunction.RESIZING_LEFT:
                case ResizingFunction.RESIZING_RIGHT:
                    side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP_AND_BOTTOM_SYMMETRICALLY;
                    break;

                case ResizingFunction.MOVING:
                default:
                    if (!(clamped_sides & ClampedSide.CLAMPED_BOTTOM)) side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
                    else if (!(clamped_sides & ClampedSide.CLAMPED_RIGHT)) side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
                    else if (!(clamped_sides & ClampedSide.CLAMPED_TOP)) side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
                    else if (!(clamped_sides & ClampedSide.CLAMPED_LEFT)) side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
                    break;
            }
        }

        /* We now know what side(s) we should resize, so now we just solve
         * the aspect equation for that side(s).
         */
        switch (side_to_resize) {
            case SideToResize.SIDE_TO_RESIZE_NONE:
                return;

            case SideToResize.SIDE_TO_RESIZE_LEFT:
                this.rectangle.x1 = this.rectangle.x2 - aspect * current_h;
                break;

            case SideToResize.SIDE_TO_RESIZE_RIGHT:
                this.rectangle.x2 = this.rectangle.x1 + aspect * current_h;
                break;

            case SideToResize.SIDE_TO_RESIZE_TOP:
                this.rectangle.y1 = this.rectangle.y2 - current_w / aspect;
                break;

            case SideToResize.SIDE_TO_RESIZE_BOTTOM:
                this.rectangle.y2 = this.rectangle.y1 + current_w / aspect;
                break;

            case SideToResize.SIDE_TO_RESIZE_TOP_AND_BOTTOM_SYMMETRICALLY:
                {
                    const correct_h = current_w / aspect;

                    this.rectangle.y1 = this.rectangle.center_y_on_fixed_center - correct_h / 2;
                    this.rectangle.y2 = this.rectangle.y1 + correct_h;
                }
                break;

            case SideToResize.SIDE_TO_RESIZE_LEFT_AND_RIGHT_SYMMETRICALLY:
                {
                    const correct_w = current_h * aspect;

                    this.rectangle.x1 = this.rectangle.center_x_on_fixed_center - correct_w / 2;
                    this.rectangle.x2 = this.rectangle.x1 + correct_w;
                }
                break;
        }
    }

    // #endregion

    // #region Apply Coordinates

    ApplyCoordinates(coord_x: number, coord_y: number) {
        if (this.rectangle.function === ResizingFunction.MOVING) {
            /* Preserve width and height while moving the grab-point to where the
             * cursor is.
             */
            const w = this.rectangle.x2 - this.rectangle.x1;
            const h = this.rectangle.y2 - this.rectangle.y1;

            // For proper rectangle positioning, we must adjust the mouse coords coming in (which are anchored on the center
            // drag handle) by the offsets from the upper-left corner determined upon the mouse down event.
            this.rectangle.x1 = coord_x - (this.HandleOffset?.dx ?? 0);
            this.rectangle.y1 = coord_y - (this.HandleOffset?.dy ?? 0);

            this.rectangle.x2 = this.rectangle.x1 + w;
            this.rectangle.y2 = this.rectangle.y1 + h;

            /* We are done already. */
            return;
        }

        switch (this.rectangle.function) {
            case ResizingFunction.RESIZING_UPPER_LEFT:
            case ResizingFunction.RESIZING_LOWER_LEFT:
            case ResizingFunction.RESIZING_LEFT:
                this.rectangle.x1 = coord_x - (this.HandleOffset?.dx ?? 0);

                if (this.rectangle.fixed_center) this.rectangle.x2 = 2 * this.rectangle.center_x_on_fixed_center - this.rectangle.x1;

                break;

            case ResizingFunction.RESIZING_UPPER_RIGHT:
            case ResizingFunction.RESIZING_LOWER_RIGHT:
            case ResizingFunction.RESIZING_RIGHT:
                this.rectangle.x2 = coord_x - (this.HandleOffset?.dx ?? 0);

                if (this.rectangle.fixed_center) this.rectangle.x1 = 2 * this.rectangle.center_x_on_fixed_center - this.rectangle.x2;

                break;

            default:
                break;
        }

        switch (this.rectangle.function) {
            case ResizingFunction.RESIZING_UPPER_LEFT:
            case ResizingFunction.RESIZING_UPPER_RIGHT:
            case ResizingFunction.RESIZING_TOP:
                this.rectangle.y1 = coord_y - (this.HandleOffset?.dy ?? 0);

                if (this.rectangle.fixed_center) this.rectangle.y2 = 2 * this.rectangle.center_y_on_fixed_center - this.rectangle.y1;

                break;

            case ResizingFunction.RESIZING_LOWER_LEFT:
            case ResizingFunction.RESIZING_LOWER_RIGHT:
            case ResizingFunction.RESIZING_BOTTOM:
                this.rectangle.y2 = coord_y - (this.HandleOffset?.dy ?? 0);

                if (this.rectangle.fixed_center) this.rectangle.y1 = 2 * this.rectangle.center_y_on_fixed_center - this.rectangle.y2;

                break;

            default:
                break;
        }
    }

    // #endregion

    // #region Apply Sizing Requirements

    ApplySizingRequirements() {
        const constraint = this.rectangle.constraint;

        if (this.rectangle.fixed_rule_active && this.rectangle.fixed_rule == FixedRule.ASPECT) {
            const aspect = this.CLAMP(
                this.rectangle.aspect_numerator / this.rectangle.aspect_denominator,
                1.0 / this.ContainerBox.height,
                this.ContainerBox.width
            ); // In GIMP, this is 1.0 / image_height, image_width

            if (constraint == RectangleConstraint.CONSTRAIN_NONE) {
                this.ApplyProperAspectRatio(aspect, ClampedSide.CLAMPED_NONE);
            } else {
                if (this.rectangle.function !== ResizingFunction.MOVING) {
                    let clamped_sides: ClampedSide = ClampedSide.CLAMPED_NONE;

                    this.ApplyProperAspectRatio(aspect, clamped_sides);

                    /* After we have applied aspect, we might have taken the
                     * rectangle outside of constraint, so clamp and apply
                     * aspect again. We will get the right result this time,
                     * since 'clamped_sides' will be setup correctly now.
                     */
                    clamped_sides = this.ClampRectangle(clamped_sides, constraint, this.rectangle.fixed_center);

                    this.ApplyProperAspectRatio(aspect, clamped_sides);
                } else {
                    this.ApplyProperAspectRatio(aspect, ClampedSide.CLAMPED_NONE);

                    this.KeepRectangleInsideParent(constraint);
                }
            }
        }
    }

    // #endregion

    // #region Check Resizing Function

    CheckResizingFunction() {
        let newFunc: ResizingFunction = this.rectangle.function;

        if (this.rectangle.x2 < this.rectangle.x1) {
            [this.rectangle.x1, this.rectangle.x2] = [this.rectangle.x2, this.rectangle.x1];

            switch (newFunc) {
                case ResizingFunction.RESIZING_UPPER_LEFT:
                    newFunc = ResizingFunction.RESIZING_UPPER_RIGHT;
                    break;
                case ResizingFunction.RESIZING_UPPER_RIGHT:
                    newFunc = ResizingFunction.RESIZING_UPPER_LEFT;
                    break;
                case ResizingFunction.RESIZING_LOWER_LEFT:
                    newFunc = ResizingFunction.RESIZING_LOWER_RIGHT;
                    break;
                case ResizingFunction.RESIZING_LOWER_RIGHT:
                    newFunc = ResizingFunction.RESIZING_LOWER_LEFT;
                    break;
                case ResizingFunction.RESIZING_LEFT:
                    newFunc = ResizingFunction.RESIZING_RIGHT;
                    break;
                case ResizingFunction.RESIZING_RIGHT:
                    newFunc = ResizingFunction.RESIZING_LEFT;
                    break;
                default:
                    break;
            }
        }

        if (this.rectangle.y2 < this.rectangle.y1) {
            [this.rectangle.y1, this.rectangle.y2] = [this.rectangle.y2, this.rectangle.y1];

            switch (newFunc) {
                case ResizingFunction.RESIZING_UPPER_LEFT:
                    newFunc = ResizingFunction.RESIZING_LOWER_LEFT;
                    break;
                case ResizingFunction.RESIZING_UPPER_RIGHT:
                    newFunc = ResizingFunction.RESIZING_LOWER_RIGHT;
                    break;
                case ResizingFunction.RESIZING_LOWER_LEFT:
                    newFunc = ResizingFunction.RESIZING_UPPER_LEFT;
                    break;
                case ResizingFunction.RESIZING_LOWER_RIGHT:
                    newFunc = ResizingFunction.RESIZING_UPPER_RIGHT;
                    break;
                case ResizingFunction.RESIZING_TOP:
                    newFunc = ResizingFunction.RESIZING_BOTTOM;
                    break;
                case ResizingFunction.RESIZING_BOTTOM:
                    newFunc = ResizingFunction.RESIZING_TOP;
                    break;
                default:
                    break;
            }
        }

        this.SetResizingFunction(newFunc);
    }

    // #endregion

    // #region Clamp Rectangle

    ClampRectangle(clamped_sides: ClampedSide, constraint: RectangleConstraint, symmetrically: boolean) {
        // First we clamp in the width of the rectangle. Since JS/TS does not have a concept of
        // passing arguments by reference, we capture the return of this method in the same variable to update it.
        clamped_sides = this.ClampRectangleWidth(clamped_sides, constraint, symmetrically);

        // Now we clamp in the height of the rectangle.
        clamped_sides = this.ClampRectangleHeight(clamped_sides, constraint, symmetrically);

        return clamped_sides;
    }

    // #endregion

    // #region Clamp Rectangle Height

    ClampRectangleHeight(clamped_sides: ClampedSide, constraint: RectangleConstraint, symmetrically: boolean) {
        let min_y: number | null = null;
        let max_y: number | null = null;

        if (constraint == RectangleConstraint.CONSTRAIN_NONE) return clamped_sides;

        const constraints = this.GetParentContainerBoundaries(constraint);

        min_y = constraints.min_y;
        max_y = constraints.max_y;

        if (this.rectangle.y1 < min_y) {
            const dy = min_y - this.rectangle.y1;

            this.rectangle.y1 += dy;

            if (symmetrically) this.rectangle.y2 -= dy;

            if (this.rectangle.y2 < min_y) this.rectangle.y2 = min_y;

            if (clamped_sides != null) clamped_sides |= ClampedSide.CLAMPED_TOP;
        }

        if (this.rectangle.y2 > max_y) {
            const dy = max_y - this.rectangle.y2;

            this.rectangle.y2 += dy;

            if (symmetrically) this.rectangle.y1 -= dy;

            if (this.rectangle.y1 > max_y) this.rectangle.y1 = max_y;

            if (clamped_sides != null) clamped_sides |= ClampedSide.CLAMPED_BOTTOM;
        }

        return clamped_sides;
    }

    // #endregion

    // #region Clamp Rectangle Width

    ClampRectangleWidth(clamped_sides: ClampedSide, constraint: RectangleConstraint, symmetrically: boolean) {
        let min_x: number | null = null;
        let max_x: number | null = null;

        if (constraint == RectangleConstraint.CONSTRAIN_NONE) return clamped_sides;

        const constraints = this.GetParentContainerBoundaries(constraint);

        min_x = constraints.min_x;
        max_x = constraints.max_x;

        if (this.rectangle.x1 < min_x) {
            const dx = min_x - this.rectangle.x1;

            this.rectangle.x1 += dx;

            if (symmetrically) this.rectangle.x2 -= dx;

            if (this.rectangle.x2 < min_x) this.rectangle.x2 = min_x;

            if (clamped_sides != null) clamped_sides |= ClampedSide.CLAMPED_LEFT;
        }

        if (this.rectangle.x2 > max_x) {
            const dx = max_x - this.rectangle.x2;

            this.rectangle.x2 += dx;

            if (symmetrically) this.rectangle.x1 -= dx;

            if (this.rectangle.x1 > max_x) this.rectangle.x1 = max_x;

            if (clamped_sides != null) clamped_sides |= ClampedSide.CLAMPED_RIGHT;
        }

        return clamped_sides;
    }

    // #endregion

    // #region Emit Resized Rectangle

    EmitResizedRectangle() {
        // Translate coords from viewport to relative coords to container parent.
        let top = this.rectangle.y1 - this.ContainerBox.y1 - this.ContainerBox.topBorder;
        let left = this.rectangle.x1 - this.ContainerBox.x1 - this.ContainerBox.leftBorder;

        // Emit the position information.
        this.appDragFrameResize.emit({
            x: left,
            y: top,
            width: this.rectangle.width,
            height: this.rectangle.height,
        } as SimpleRectangle);
    }

    // #endregion

    // #region Get Parent Container Boundaries

    GetParentContainerBoundaries(constraint: RectangleConstraint) {
        // For now, just return the usable viewport coordinates inside of the container box. Note that we must only use the interior
        // coordinates (not the overall x1,y1-x2,y2), since the overall includes the borders.
        return {
            min_x: this.ContainerBox.x1 + this.ContainerBox.leftBorder,
            min_y: this.ContainerBox.y1 + this.ContainerBox.topBorder,
            max_x: this.ContainerBox.x2 - this.ContainerBox.rightBorder,
            max_y: this.ContainerBox.y2 - this.ContainerBox.bottomBorder,
        };

        // GimpDisplayShell *shell;
        // GimpImage        *image;
        // min_x_dummy: number;
        // min_y_dummy: number;
        // max_x_dummy: number;
        // max_y_dummy: number;

        // shell = gimp_tool_widget_get_shell (GIMP_TOOL_WIDGET (rectangle));
        // image = gimp_display_get_image (shell->display);

        // if (min_x == null) min_x = min_x_dummy;
        // if (min_y == null) min_y = min_y_dummy;
        // if (max_x == null) max_x = max_x_dummy;
        // if (max_y == null) max_y = max_y_dummy;

        // min_x = 0;
        // min_y = 0;
        // max_x = 0;
        // max_y = 0;

        // switch (constraint)
        // {
        // case CONSTRAIN_IMAGE:
        // if (image)
        // {
        // min_x = 0;
        // min_y = 0;
        // max_x = gimp_image_get_width  (image);
        // max_y = gimp_image_get_height (image);
        // }
        // break;

        // case CONSTRAIN_DRAWABLE:
        // if (image)
        // {
        // GList *items = gimp_image_get_selected_drawables (image);
        // GList *iter;

        // /* Min and max constraints are respectively the smallest and
        // * highest drawable coordinates.
        // */
        // for (iter = items; iter; iter = iter->next)
        // {
        // gint item_min_x;
        // gint item_min_y;

        // gimp_item_get_offset (iter->data, &item_min_x, &item_min_y);

        // min_x = Math.min(min_x, item_min_x);
        // min_y = Math.min(min_y, item_min_y);
        // max_x = Math.min(max_x, item_min_x + gimp_item_get_width  (iter->data));
        // max_y = Math.min(max_y, item_min_y + gimp_item_get_height (iter->data));
        // }

        // g_list_free (items);
        // }
        // break;

        // default:
        // return {
        //     min_x: min_x,
        // min_y: min_y,
        // max_x: max_x,
        // max_y: max_y
        // };
        // }
    }

    // #endregion

    // #region Get Rectangle Public Coordinates

    GetRectanglePublicCoordinates() {
        let x1: number, y1: number, x2: number, y2: number;

        switch (this.rectangle.precision) {
            case Precision.INT:
                x1 = this.rectangle.x1_int;
                y1 = this.rectangle.y1_int;
                x2 = this.rectangle.x1_int + this.rectangle.width_int;
                y2 = this.rectangle.y1_int + this.rectangle.height_int;
                break;

            case Precision.DOUBLE:
            default:
                x1 = this.rectangle.x1;
                y1 = this.rectangle.y1;
                x2 = this.rectangle.x2;
                y2 = this.rectangle.y2;
                break;
        }

        return { x1: x1, y1: y1, x2: x2, y2: y2 };
    }

    // #endregion

    // #region Get Rectangle Other Side

    GetRectangleOtherSide() {
        let other_x: number | null;
        let other_y: number | null;

        switch (this.rectangle.function) {
            case ResizingFunction.RESIZING_UPPER_RIGHT:
            case ResizingFunction.RESIZING_LOWER_RIGHT:
            case ResizingFunction.RESIZING_RIGHT:
                other_x = this.rectangle.x1;
                break;

            case ResizingFunction.RESIZING_UPPER_LEFT:
            case ResizingFunction.RESIZING_LOWER_LEFT:
            case ResizingFunction.RESIZING_LEFT:
                other_x = this.rectangle.x2;
                break;

            case ResizingFunction.RESIZING_TOP:
            case ResizingFunction.RESIZING_BOTTOM:
            default:
                other_x = null;
                break;
        }

        switch (this.rectangle.function) {
            case ResizingFunction.RESIZING_LOWER_RIGHT:
            case ResizingFunction.RESIZING_LOWER_LEFT:
            case ResizingFunction.RESIZING_BOTTOM:
                other_y = this.rectangle.y1;
                break;

            case ResizingFunction.RESIZING_UPPER_RIGHT:
            case ResizingFunction.RESIZING_UPPER_LEFT:
            case ResizingFunction.RESIZING_TOP:
                other_y = this.rectangle.y2;
                break;

            case ResizingFunction.RESIZING_LEFT:
            case ResizingFunction.RESIZING_RIGHT:
            default:
                other_y = null;
                break;
        }

        return {
            other_x: other_x,
            other_y: other_y,
        };
    }

    // #endregion

    // #region Get Rectangle Other Side Coords

    GetRectangleOtherSideCoords() {
        let other_x: number | null = null;
        let other_y: number | null = null;

        const other_side = this.GetRectangleOtherSide();

        if (other_side?.other_x != null) other_x = other_side.other_x;
        if (other_side?.other_y != null) other_y = other_side.other_y;

        return {
            other_side_x: other_x,
            other_side_y: other_y,
        };
    }

    // #endregion

    // #region Handle General Clamping

    HandleGeneralClamping() {
        const constraint = this.rectangle.constraint;

        /* fixed_aspect takes care of clamping by it self, so just return in
         * case that is in use. Also return if no constraints should be
         * enforced.
         */
        if (constraint === RectangleConstraint.CONSTRAIN_NONE) return;

        if (this.rectangle.function !== ResizingFunction.MOVING) {
            this.ClampRectangle(ClampedSide.CLAMPED_NONE, constraint, this.rectangle.fixed_center);
        } else {
            this.KeepRectangleInsideParent(constraint);
        }
    }

    // #endregion

    // #region Initialize Rectangle

    InitializeRectangle() {
        const r = {
            x1: this.FrameBox.x1 ?? 0,
            y1: this.FrameBox.y1 ?? 0,
            x2: this.FrameBox.x2 ?? 0,
            y2: this.FrameBox.y2 ?? 0,
            constraint: RectangleConstraint.CONSTRAIN_IMAGE,
            precision: Precision.INT,
            function: ResizingFunction.RESIZING_NONE,
            narrow_mode: false,
            force_narrow_mode: false,
            x: 0,
            y: 0,
            width: this.FrameBox.width ?? 0,
            height: this.FrameBox.height ?? 0,
            fixed_rule_active: false,
            fixed_rule: FixedRule.ASPECT,
            aspect_numerator: 1,
            aspect_denominator: 1,
            fixed_center: false,
            x1_int: this.SIGNED_ROUND(this.FrameBox.x1 ?? 0),
            y1_int: this.SIGNED_ROUND(this.FrameBox.y1 ?? 0),
            width_int: this.SIGNED_ROUND(this.FrameBox.width ?? 0),
            height_int: this.SIGNED_ROUND(this.FrameBox.height ?? 0),
        } as Rectangle;

        return r;
    }

    // #endregion

    // #region Is Rectangle Adjusting

    IsRectangleAdjusting() {
        return this.IsRectangleRubberBanding() || this.rectangle.function === ResizingFunction.MOVING;
    }

    // #endregion

    // #region Is Rectangle Rubber Banding

    IsRectangleRubberBanding() {
        switch (this.rectangle.function) {
            case ResizingFunction.CREATING:
            case ResizingFunction.RESIZING_LEFT:
            case ResizingFunction.RESIZING_RIGHT:
            case ResizingFunction.RESIZING_TOP:
            case ResizingFunction.RESIZING_BOTTOM:
            case ResizingFunction.RESIZING_UPPER_LEFT:
            case ResizingFunction.RESIZING_UPPER_RIGHT:
            case ResizingFunction.RESIZING_LOWER_LEFT:
            case ResizingFunction.RESIZING_LOWER_RIGHT:
            case ResizingFunction.AUTO_SHRINK:
                return true;

            case ResizingFunction.MOVING:
            case ResizingFunction.DEAD:
            default:
                break;
        }

        return false;
    }

    // #endregion

    // #region Keep Rectangle Inside Parent

    KeepRectangleInsideParent(constraint: RectangleConstraint) {
        this.KeepRectangleInsideParentHorizontally(constraint);
        this.KeepRectangleInsideParentVertically(constraint);
    }

    // #endregion

    // #region Keep Rectangle Inside Parent Horizontally

    KeepRectangleInsideParentHorizontally(constraint: RectangleConstraint) {
        let min_x: number | null = null;
        let max_x: number | null = null;

        if (constraint == RectangleConstraint.CONSTRAIN_NONE) return;

        const constraints = this.GetParentContainerBoundaries(constraint);

        min_x = constraints.min_x;
        max_x = constraints.max_x;

        if (max_x - min_x < this.rectangle.x2 - this.rectangle.x1) {
            this.rectangle.x1 = min_x;
            this.rectangle.x2 = max_x;
        } else {
            if (this.rectangle.x1 < min_x) {
                const dx = min_x - this.rectangle.x1;

                this.rectangle.x1 += dx;
                this.rectangle.x2 += dx;
            }
            if (this.rectangle.x2 > max_x) {
                const dx = max_x - this.rectangle.x2;

                this.rectangle.x1 += dx;
                this.rectangle.x2 += dx;
            }
        }
    }

    // #endregion

    // #region Keep Rectangle Inside Parent Vertically

    KeepRectangleInsideParentVertically(constraint: RectangleConstraint) {
        let min_y: number | null = null;
        let max_y: number | null = null;

        if (constraint == RectangleConstraint.CONSTRAIN_NONE) return;

        const constraints = this.GetParentContainerBoundaries(constraint);

        min_y = constraints.min_y;
        max_y = constraints.max_y;

        if (max_y - min_y < this.rectangle.y2 - this.rectangle.y1) {
            this.rectangle.y1 = min_y;
            this.rectangle.y2 = max_y;
        } else {
            if (this.rectangle.y1 < min_y) {
                const dy = min_y - this.rectangle.y1;

                this.rectangle.y1 += dy;
                this.rectangle.y2 += dy;
            }
            if (this.rectangle.y2 > max_y) {
                const dy = max_y - this.rectangle.y2;

                this.rectangle.y1 += dy;
                this.rectangle.y2 += dy;
            }
        }
    }

    // #endregion

    // #region Set Resizing Function

    SetResizingFunction(func: ResizingFunction) {
        if (this.rectangle.function !== func) {
            this.rectangle.function = func;

            // rectangle_changed (GIMP_TOOL_WIDGET (rectangle));
        }
    }

    // #endregion

    // #region Setup Drag Handles

    SetupDragHandles() {
        const self = this;

        // Ensure we have drag handles to work with.
        if (!self.DragHandles?.length) return;

        // Unsubscribe from the current drag operation (if any) which is still in progress or waiting to occur.
        self.ActiveDragSub?.unsubscribe();
        self.ActiveDragSub = null;

        // Collect all of the native elements from the drag handle directives so we can attach a handler to each as a whole unit.
        const dhands = self.DragHandles.map((d) => d.ele.nativeElement);

        // Create two mouse related subscriptions on the document.
        let $mousemove: Observable<MouseEvent> | null = fromEvent<MouseEvent>(document, 'mousemove');
        let $mouseup: Observable<MouseEvent> | null = fromEvent<MouseEvent>(document, 'mouseup');

        // Wire up the main event sub chain
        self.ActiveDragSub = fromEvent<MouseEvent>(dhands, 'mousedown')
            .pipe(
                // Don't react to any mouse down event other than the primary mouse button (ie, don't trigger for right-clicks)
                filter((e) => e.button === 0),
                // Bundle the mousedown event info along with the actual drag handle instance that initiated this, so we know what
                // kind of drag/resize we're performing.
                map((d) => ({
                    Event: d,
                    Handle: self.DragHandles.find(
                        (d1) => d1.ele.nativeElement === d.target || d1.ele.nativeElement.contains(d.target as HTMLElement)
                    ),
                })),
                // Don't proceed with this drag/resize operation if we somehow don't have the mousemove and mouseup handlers ready,
                // or if we don't have knowledge of the triggering handle.
                filter((ev) => !!$mousemove && !!$mouseup && !!ev.Handle),
                tap((d) => {
                    // Be sure to cancel the default operation. This is because someone long pressing on a drag handle can trigger the
                    // built-in browser's "drag this image/element to another app" behavior, which we do not want as it interrupts our
                    // process.
                    d.Event?.preventDefault();

                    // Capture which handle is active now.
                    self.ActiveHandle = d.Handle ?? null;

                    // Set the rectangle function.
                    let rfunction: ResizingFunction = ResizingFunction.RESIZING_NONE;

                    switch (this.ActiveHandle?.appDragHandle || '') {
                        case 'resize-nw':
                            rfunction = ResizingFunction.RESIZING_UPPER_LEFT;
                            break;
                        case 'resize-n':
                            rfunction = ResizingFunction.RESIZING_TOP;
                            break;
                        case 'resize-ne':
                            rfunction = ResizingFunction.RESIZING_UPPER_RIGHT;
                            break;
                        case 'resize-e':
                            rfunction = ResizingFunction.RESIZING_RIGHT;
                            break;
                        case 'resize-se':
                            rfunction = ResizingFunction.RESIZING_LOWER_RIGHT;
                            break;
                        case 'resize-s':
                            rfunction = ResizingFunction.RESIZING_BOTTOM;
                            break;
                        case 'resize-sw':
                            rfunction = ResizingFunction.RESIZING_LOWER_LEFT;
                            break;
                        case 'resize-w':
                            rfunction = ResizingFunction.RESIZING_LEFT;
                            break;
                        case 'move':
                            rfunction = ResizingFunction.MOVING;
                            break;
                        default:
                            rfunction = ResizingFunction.RESIZING_NONE;
                    }

                    this.SetResizingFunction(rfunction);

                    // Setup the handle offsets for precision tracking.
                    this.SetupHandleOffsets(d.Event.clientX, d.Event.clientY);

                    // // Broadcast the drag begin information to the parent directive.
                    // this.appDragFrameBegin.emit({
                    //     ResizingFunction: rfunction,
                    // });

                    // this.rectangle_setup_snap_offsets(this.rectangle, coords);
                    // this.widget_get_snap_offsets (widget, &snap_x, &snap_y, NULL, NULL);

                    let snapped_x = d.Event.clientX; // coords.x + snap_x;
                    let snapped_y = d.Event.clientY; // coords.y + snap_y;

                    this.rectangle.lastx = snapped_x;
                    this.rectangle.lasty = snapped_y;

                    if (this.rectangle.function == ResizingFunction.CREATING) {
                        /* Remember that this rectangle was created from scratch. */
                        this.rectangle.is_new = true;

                        this.rectangle.x1 = this.rectangle.x2 = snapped_x;
                        this.rectangle.y1 = this.rectangle.y2 = snapped_y;

                        /* Unless forced, created rectangles should not be started in
                         * narrow-mode
                         */
                        if (this.rectangle.force_narrow_mode) this.rectangle.narrow_mode = true;
                        else this.rectangle.narrow_mode = false;

                        /* If the rectangle is being modified we want the center on
                         * fixed_center to be at the center of the currently existing
                         * rectangle, otherwise we want the point where the user clicked
                         * to be the center on fixed_center.
                         */
                        this.rectangle.center_x_on_fixed_center = snapped_x;
                        this.rectangle.center_y_on_fixed_center = snapped_y;

                        /* When the user toggles modifier keys, we want to keep track of
                         * what coordinates the "other side" should have. If we are
                         * creating a rectangle, use the current mouse coordinates as
                         * the coordinate of the "other side", otherwise use the
                         * immediate "other side" for that.
                         */
                        this.rectangle.other_side_x = snapped_x;
                        this.rectangle.other_side_y = snapped_y;
                    } else {
                        /* This rectangle was not created from scratch. */
                        this.rectangle.is_new = false;

                        this.rectangle.center_x_on_fixed_center = (this.rectangle.x1 + this.rectangle.x2) / 2;
                        this.rectangle.center_y_on_fixed_center = (this.rectangle.y1 + this.rectangle.y2) / 2;

                        const rectcoords = this.GetRectangleOtherSideCoords();

                        this.rectangle.other_side_x = rectcoords.other_side_x;
                        this.rectangle.other_side_y = rectcoords.other_side_y;
                    }

                    this.UpdateIntegerCoordinates();

                    /* Is the rectangle being rubber-banded? */
                    this.rectangle.rect_adjusting = this.IsRectangleAdjusting();

                    // this.rectangle_changed(widget);
                }),
                // Use switchMap to change over from working with mousedown observables to working with mousemove observables, so we
                // can track the progress of the mouse cursor as we're engaged in this drag/resize.
                switchMap(() =>
                    $mousemove!.pipe(
                        tap((event) => {
                            // How we update the internal rectange coords depends on if we are moving or not. If we aren't, we use the
                            // true viewport coords. If we are moving, we must translate the mouse viewport coords to coords of the
                            // upper-left corner of the frame being moved.
                            this.UpdateWithCoordinates(event.clientX, event.clientY);

                            if (this.rectangle.function === ResizingFunction.RESIZING_NONE) {
                                // Was .CREATING?
                                let dx = event.clientX - this.rectangle.lastx;
                                let dy = event.clientY - this.rectangle.lasty;

                                /* When the user starts to move the cursor, set the current
                                 * function to one of the corner-grabbed functions, depending on
                                 * in what direction the user starts dragging the rectangle.
                                 */
                                // Replaced by using the handle in use to determine the resizing function.
                                let rfunction: ResizingFunction = ResizingFunction.RESIZING_NONE;

                                // if (dx < 0) {
                                //     rfunction = dy < 0 ? ResizingFunction.RESIZING_UPPER_LEFT : ResizingFunction.RESIZING_LOWER_LEFT;
                                // } else if (dx > 0) {
                                //     rfunction = dy < 0 ? ResizingFunction.RESIZING_UPPER_RIGHT : ResizingFunction.RESIZING_LOWER_RIGHT;
                                // } else if (dy < 0) {
                                //     rfunction = dx < 0 ? ResizingFunction.RESIZING_UPPER_LEFT : ResizingFunction.RESIZING_UPPER_RIGHT;
                                // } else if (dy > 0) {
                                //     rfunction = dx < 0 ? ResizingFunction.RESIZING_LOWER_LEFT : ResizingFunction.RESIZING_LOWER_RIGHT;
                                // }

                                // this.rectangle_set_function(rfunction);

                                if (this.rectangle.fixed_rule_active && this.rectangle.fixed_rule === FixedRule.FIXED_SIZE) {
                                    /* For fixed size, set the function to moving immediately since the
                                     * rectangle can not be resized anyway.
                                     */

                                    /* We fake a coord update to get the right size. */
                                    this.UpdateWithCoordinates(event.clientX, event.clientY);

                                    // gimp_tool_widget_set_snap_offsets (widget,
                                    //                                    -(private->x2 - private->x1) / 2,
                                    //                                    -(private->y2 - private->y1) / 2,
                                    //                                    private->x2 - private->x1,
                                    //                                    private->y2 - private->y1);

                                    this.SetResizingFunction(ResizingFunction.MOVING);
                                }
                            }

                            this.UpdateOptions();

                            this.rectangle.lastx = event.clientX;
                            this.rectangle.lasty = event.clientY;

                            // Signal to the parent directive that the frame has been repositioned and is ready for an animation move.
                            this.EmitResizedRectangle();
                        }),
                        takeUntil(
                            $mouseup!.pipe(
                                tap((event) => {
                                    // If this was a resize operation, now that we're done we need to lock in the new width/height of the drag frame.
                                    // if (self.ActiveHandle?.appDragHandle !== 'move') {
                                    //   self.frameWidth = self.frameEle.offsetWidth;
                                    //   self.frameHeight = self.frameEle.offsetHeight;
                                    // }

                                    // Drop the handle.
                                    self.ActiveHandle = null;
                                })
                            )
                        )
                    )
                )
            )
            .subscribe();
    }

    // #endregion

    // #region Setup Handle Offsets

    SetupHandleOffsets(coordx: number, coordy: number) {
        const self = this;

        const offsets = { dx: 0, dy: 0 } as HandleOffset;

        const handleEle = this.ActiveHandle?.ele?.nativeElement || null;

        if (!handleEle) {
            this.HandleOffset = offsets;
            return;
        }

        // Determine the handle offset, ie the difference in x/y pixels from the upper-left corner of the handle that
        // is being dragged. This will be used in move calculations to get more precise movement tracking.
        const handleRect = handleEle.getBoundingClientRect();
        let dx = 0;
        let dy = 0;

        switch (this.rectangle.function) {
            case ResizingFunction.RESIZING_UPPER_LEFT:
            case ResizingFunction.RESIZING_LEFT:
            case ResizingFunction.RESIZING_LOWER_LEFT:
                offsets.dx = handleRect.left - coordx;
                break;
            case ResizingFunction.RESIZING_UPPER_RIGHT:
            case ResizingFunction.RESIZING_RIGHT:
            case ResizingFunction.RESIZING_LOWER_RIGHT:
                offsets.dx = coordx - handleRect.right;
                break;
            case ResizingFunction.MOVING:
                offsets.dx = coordx - this.rectangle.x1;
                break;
        }

        switch (this.rectangle.function) {
            case ResizingFunction.RESIZING_UPPER_LEFT:
            case ResizingFunction.RESIZING_TOP:
            case ResizingFunction.RESIZING_UPPER_RIGHT:
                offsets.dy = coordy - handleRect.top;
                break;
            case ResizingFunction.RESIZING_LOWER_LEFT:
            case ResizingFunction.RESIZING_BOTTOM:
            case ResizingFunction.RESIZING_LOWER_RIGHT:
                offsets.dy = coordy - handleRect.bottom;
                break;
            case ResizingFunction.MOVING:
                offsets.dy = coordy - this.rectangle.y1;
                break;
        }

        this.HandleOffset = offsets;
    }

    // #endregion

    // #region Update Integer Coordinates

    UpdateIntegerCoordinates() {
        this.rectangle.x1_int = this.SIGNED_ROUND(this.rectangle.x1);
        this.rectangle.y1_int = this.SIGNED_ROUND(this.rectangle.y1);

        if (this.IsRectangleRubberBanding()) {
            this.rectangle.width_int = this.SIGNED_ROUND(this.rectangle.x2) - this.rectangle.x1_int;
            this.rectangle.height_int = this.SIGNED_ROUND(this.rectangle.y2) - this.rectangle.y1_int;
        }
    }

    // #endregion

    // #region Update Options

    UpdateOptions() {
        let x1: number, y1: number;
        let x2: number, y2: number;

        const coords = this.GetRectanglePublicCoordinates();

        [x1, y1, x2, y2] = [coords.x1, coords.y1, coords.x2, coords.y2];

        if (!this.FEQUAL(this.rectangle.x, x1)) this.rectangle.x = x1;

        if (!this.FEQUAL(this.rectangle.y, y1)) this.rectangle.y = y1;

        if (!this.FEQUAL(this.rectangle.width, x2 - x1)) this.rectangle.width = x2 - x1;

        if (!this.FEQUAL(this.rectangle.height, y2 - y1)) this.rectangle.height = y2 - y1;
    }

    // #endregion

    // #region Update With Coordinates

    UpdateWithCoordinates(new_x: number, new_y: number) {
        // Apply the provided new x,y coordinates to the rectangle's position.
        this.ApplyCoordinates(new_x, new_y);

        // Check to see if the user's mouse interactions have caused the drag frame to
        // "mirror" (such as by dragging the right edge past the left edge). If so, we need to
        // change the kind of resize operation being performed.
        this.CheckResizingFunction();

        // Now we perform very general clamping on the moved/resized rectangle.
        this.HandleGeneralClamping();

        // If we are not moving the rectangle but actually resizing it, it's time to ensure that the rectangle obeys
        // aspect ratio rules and/or fixed size constraints.
        if (this.rectangle.function !== ResizingFunction.MOVING) {
            this.ApplySizingRequirements();
        }

        this.UpdateIntegerCoordinates();
    }

    // #endregion
}

@Directive({
    selector: '[app-drag]',
})
export class DragDirective implements OnDestroy {
    private _subrelease = new Subscription();
    set subrelease(sub: TeardownLogic) {
        this._subrelease.add(sub);
    }

    @ContentChildren(DragShadowDirective) set shadowLayers(_sl: QueryList<DragShadowDirective> | null) {
        this._shadowLayers = _sl;
    }
    get ShadowLayers() {
        return (this._shadowLayers?.map((s) => s) || []) as DragShadowDirective[];
    }
    private _shadowLayers: QueryList<DragShadowDirective> | null = null;

    @ContentChild(DragFrameDirective) set appDragFrame(_df: DragFrameDirective | null) {
        this._appDragFrame = _df;

        this.frameEle = (_df?.ele?.nativeElement ?? null) as HTMLElement | null;

        if (this.frameEle) {
            // Subscribe to notifications from the drag frame that a resize/move event has happened.
            this.subrelease = _df?.appDragFrameResize.subscribe((val: SimpleRectangle) => {
                // Move the UI drag frame according to the provided position info.
                this.RedrawFrameBox(val);
            });
        }
    }
    get appDragFrame() {
        return this._appDragFrame as DragFrameDirective;
    }
    private _appDragFrame: DragFrameDirective | null = null;

    // Properties that track the drag frame and the container of the draggable item.
    private frameEle: HTMLElement | null = null;

    constructor(private el: ElementRef) {}

    ngAfterContentInit(): void {
        const self = this;

        console.log(this.ShadowLayers);
    }

    ngOnDestroy(): void {
        this._subrelease?.unsubscribe();
    }

    // #region Redraw Frame Box

    RedrawFrameBox(rect: SimpleRectangle) {
        if (this.frameEle) {
            this.frameEle.style.top = `${rect.y}px`;
            this.frameEle.style.left = `${rect.x}px`;
            this.frameEle.style.width = `${rect.width}px`;
            this.frameEle.style.height = `${rect.height}px`;
        }
    }

    // #endregion
}

interface SimpleRectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface HandleOffset {
    dx: number;
    dy: number;
}

interface Rectangle {
    /* The following members are "constants", that is, variables that are setup
     * during gimp_tool_rectangle_button_press and then only read.
     */

    /* Whether or not the rectangle currently being rubber-banded is the
     * first one created with this instance, this determines if we can
     * undo it on button_release.
     */
    is_first: boolean;

    /* Whether or not the rectangle currently being rubber-banded was
     * created from scratch.
     */
    is_new: boolean;

    /* Holds the coordinate that should be used as the "other side" when
     * fixed-center is turned off.
     */
    other_side_x: number | null;
    other_side_y: number | null;

    /* Holds the coordinate to be used as center when fixed-center is used. */
    center_x_on_fixed_center: number;
    center_y_on_fixed_center: number;

    /* True when the rectangle is being adjusted (moved or
     * rubber-banded).
     */
    rect_adjusting: boolean;

    /* The rest of the members are internal state variables, that is, variables
     * that might change during the manipulation session of the rectangle. Make
     * sure these variables are in consistent states.
     */

    /* Coordinates of upper left and lower right rectangle corners. */
    x1: number;
    y1: number;
    x2: number;
    y2: number;

    /* Integer coordinates of upper left corner and size. We must
     * calculate this separately from the gdouble ones because sometimes
     * we don't want to affect the integer size (e.g. when moving the
     * rectangle), but that will be the case if we always calculate the
     * integer coordinates based on rounded values of the gdouble
     * coordinates even if the gdouble width remains constant.
     *
     * TODO: Change the internal double-representation of the rectangle
     * to x,y width,height instead of x1,y1 x2,y2. That way we don't
     * need to keep a separate representation of the integer version of
     * the rectangle; rounding width an height will yield consistent
     * results and not depend on position of the rectangle.
     */
    x1_int: number;
    y1_int: number;
    width_int: number;
    height_int: number;

    /* How to constrain the rectangle. */
    constraint: RectangleConstraint;

    /* What precision the rectangle will appear to have externally (it
     * will always be double internally)
     */
    precision: Precision;

    /* Previous coordinate applied to the rectangle. */
    lastx: number;
    lasty: number;

    /* Whether or not the rectangle is in a 'narrow situation' i.e. it is
     * too small for reasonable sized handle to be inside. In this case
     * we put handles on the outside.
     */
    narrow_mode: boolean;

    /* This boolean allows to always set narrow mode */
    force_narrow_mode: boolean;

    function: ResizingFunction;

    /* The following values are externally synced with GimpRectangleOptions */
    x: number;
    y: number;
    width: number;
    height: number;
    fixed_center: boolean;
    fixed_rule: FixedRule;
    fixed_rule_active: boolean;
    aspect_numerator: number;
    aspect_denominator: number;
}

interface FramePosition {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    width: number;
    height: number;
    centerx: number;
    centery: number;
    topBorder: number;
    leftBorder: number;
    rightBorder: number;
    bottomBorder: number;
}

enum ResizingFunction {
    RESIZING_NONE,
    RESIZING_LEFT,
    RESIZING_RIGHT,
    RESIZING_UPPER_LEFT,
    RESIZING_UPPER_RIGHT,
    RESIZING_LOWER_LEFT,
    RESIZING_LOWER_RIGHT,
    RESIZING_TOP,
    RESIZING_BOTTOM,
    MOVING,
    CREATING,
    AUTO_SHRINK,
    DEAD,
}

enum ClampedSide {
    CLAMPED_NONE = 0,
    CLAMPED_LEFT = 1 << 0,
    CLAMPED_RIGHT = 1 << 1,
    CLAMPED_TOP = 1 << 2,
    CLAMPED_BOTTOM = 1 << 3,
}

enum SideToResize {
    SIDE_TO_RESIZE_NONE,
    SIDE_TO_RESIZE_LEFT,
    SIDE_TO_RESIZE_RIGHT,
    SIDE_TO_RESIZE_TOP,
    SIDE_TO_RESIZE_BOTTOM,
    SIDE_TO_RESIZE_LEFT_AND_RIGHT_SYMMETRICALLY,
    SIDE_TO_RESIZE_TOP_AND_BOTTOM_SYMMETRICALLY,
}

enum RectangleConstraint {
    CONSTRAIN_NONE,
    CONSTRAIN_IMAGE,
    CONSTRAIN_DRAWABLE,
}

enum FixedRule {
    ASPECT,
    FIXED_SIZE,
    FIXED_WIDTH,
    FIXED_HEIGHT,
}

enum Precision {
    INT,
    DOUBLE,
}

interface DragInitiateEventInfo {
    ResizingFunction: ResizingFunction | null;
}
