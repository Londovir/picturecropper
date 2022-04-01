import {
  ContentChildren,
  Directive,
  ElementRef,
  Input,
  OnDestroy,
  QueryList,
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
  selector: '[app-drag]',
})
export class DragDirective implements OnDestroy {
  private _subrelease = new Subscription();
  set subrelease(sub: TeardownLogic) {
    this._subrelease.add(sub);
  }

  private _appDragParent: HTMLElement | null = null;
  @Input() set appDragParent(_adp: HTMLElement | null) {
    this._appDragParent = _adp;
  }
  @Input() appDragMinWidth: number = 50;
  @Input() appDragMinHeight: number = 50;

  @ContentChildren(DragHandleDirective) set dragHandles(
    _han: QueryList<DragHandleDirective> | null
  ) {
    this._dragHandles = _han;
  }
  get DragHandles() {
    return (this._dragHandles?.map((h) => h) || []) as DragHandleDirective[];
  }
  private _dragHandles: QueryList<DragHandleDirective> | null = null;

  // Properties that track the drag frame and the container of the draggable item.
  private frameEle: HTMLElement;
  private containerEle: HTMLElement;

  // Properties for tracking the active drag/resize operation.
  ActiveDragSub: Subscription | null = null;
  ActiveHandle: DragHandleDirective | null = null;

  // Properties used in the drag/resize operation.
  private frameRect: DOMRect;
  private containerRect: DOMRect;
  private originX: number;
  private originY: number;
  private frameX: number;
  private frameY: number;
  private frameWidth: number;
  private frameHeight: number;

  constructor(private el: ElementRef) {
    // Initialize properties as needed
    this.frameEle = el.nativeElement as HTMLElement; // This is the drag frame element, which is where the drag directive is attached to.
    this.containerEle = this.frameEle.parentElement as HTMLElement; // This is the container of the drag frame element, which bounds the range of motion for the frame.
    this.frameRect = this.frameEle.getBoundingClientRect(); // This contains info on the size and position of the drag frame element.
    this.containerRect = this.containerEle.getBoundingClientRect(); // This contains info on the size and position of the container of the drag frame element.

    // Simpler breakouts.
    [this.frameWidth, this.frameHeight] = [
      this.frameEle.offsetWidth,
      this.frameEle.offsetHeight,
    ]; // Capture the width and height of the drag frame.

    [this.frameX, this.frameY] = [
      this.frameEle.offsetLeft,
      this.frameEle.offsetTop,
    ]; // Capture the drag frame's starting/current (x,y) location relative to the container.

    [this.originX, this.originY] = [0, 0]; // Initialize the drag/resize handle origin point to defaults for now.
  }

  ngAfterContentInit(): void {
    const self = this;

    self.subrelease = self._dragHandles?.changes
      .pipe(startWith(0))
      .subscribe((hans) => {
        // If we are currently in a drag operation, cancel it.
        //  self.CancelDrag();

        // Release all subscriptions in place right now for the drag operations.
        self.ActiveDragSub?.unsubscribe();
        self.ActiveDragSub = null;

        // Set up new drag handlers as needed for the new drag handles discovered.
        self.SetupHandlers();
      });
  }

  ngOnDestroy(): void {
    this._subrelease.unsubscribe();

    // Release any lingering subscriptions.
    this.ActiveDragSub?.unsubscribe();
    this.ActiveDragSub = null;
  }

  // #region Clamp

  Clamp(num: number, min: number, max: number) {
    // Ensure the input value num is restricted to the range [min, max]
    return Math.max(Math.min(num, max), min);
  }

  // #endregion

  // #region Setup Handlers

  SetupHandlers() {
    const self = this;

    // Ensure we have drag handles to work with.
    if (!self.DragHandles?.length) return;

    // Unsubscribe from the current drag operation (if any) which is still in progress or waiting to occur.
    self.ActiveDragSub?.unsubscribe();
    self.ActiveDragSub = null;

    // Collect all of the native elements from the drag handle directives so we can attach a handler to each as a whole unit.
    const dhands = self.DragHandles.map((d) => d.ele.nativeElement);

    // Test subscription.
    let $mousemove: Observable<MouseEvent> | null = fromEvent<MouseEvent>(
      document,
      'mousemove'
    );
    let $mouseup: Observable<MouseEvent> | null = fromEvent<MouseEvent>(
      document,
      'mouseup'
    );

    self.ActiveDragSub = fromEvent<MouseEvent>(dhands, 'mousedown')
      .pipe(
        // Don't react to any mouse down event other than the primary mouse button (ie, don't trigger for right-clicks)
        filter((e) => e.button === 0),
        // Bundle the mousedown event info along with the actual drag handle instance that initiated this, so we know what
        // kind of drag/resize we're performing.
        map((d) => ({
          Event: d,
          Handle: self.DragHandles.find(
            (d1) =>
              d1.ele.nativeElement === d.target ||
              d1.ele.nativeElement.contains(d.target as HTMLElement)
          ),
        })),
        // Don't proceed with this drag/resize operation if we somehow don't have the mousemove and mouseup handlers ready,
        // or if we don't have knowledge of the triggering handle.
        filter((ev) => !!$mousemove && !!$mouseup && !!ev.Handle),
        // Be sure to cancel the default operation. This is because someone long pressing on a drag handle can trigger the
        // built-in browser's "drag this image/element to another app" behavior, which we do not want as it interrupts our
        // process.
        tap((d) => {
          d.Event?.preventDefault();

          // Capture which handle is active now.
          self.ActiveHandle = d.Handle ?? null;

          // In order to measure the distance the mouse cursor has travelled during the drag/resize operation, we have to perform a little
          // bit of math. We take the current mouse coords and subtract the initial coords of the drag handle when the drag operation starts.
          // This will provide an offset that the drag handle has moved, which is also the amount we need to move the drag frame by.
          // We begin by storing the current coords of the drag handle for use in these calculations. We also need to store the starting coords
          // of the drag frame, which is what we use to determine its new positions during the drag.
          self.originX = d.Event?.pageX ?? 0;
          self.originY = d.Event?.pageY ?? 0;
          self.frameX = self.frameEle.offsetLeft;
          self.frameY = self.frameEle.offsetTop;
        }),
        // Use switchMap to change over from working with mousedown observables to working with mousemove observables, so we
        // can track the progress of the mouse cursor as we're engaged in this drag/resize.
        switchMap(() =>
          $mousemove!.pipe(
            tap((event) => {
              if (!self._appDragParent) return;

              // Calculate the offset between the start of the drag operation and the current mouse cursor position. This offset will be used for
              // all drag/resize operations.
              const [dx, dy] = [
                event.pageX - self.originX,
                event.pageY - self.originY,
              ];

              let px: number;
              let py: number;

              // Depending on the active handle's purpose, we either move the drag item, or we resize the drag frame in a certain
              // direction.
              if (self.ActiveHandle?.appDragHandle === 'move') {
                // This is a simple move/drag operation.

                // Apply the (dx,dy) offset to the drag frame's initial upper-left (x,y) to get the new coords to move the drag frame to.
                [px, py] = [self.frameX + dx, self.frameY + dy];

                // To ensure we can't drag the drag frame out of the drag frame's containing parent element, we now clamp this (px, py) location
                // to be within that container.
                px = self.Clamp(
                  px,
                  0,
                  self._appDragParent.offsetWidth -
                    self._appDragParent.clientLeft -
                    self.frameWidth
                );
                py = self.Clamp(
                  py,
                  0,
                  self._appDragParent.offsetHeight -
                    self._appDragParent.clientTop -
                    self.frameHeight
                );

                // Now move the drag frame to these new coordinates.
                self.frameEle.style.top = `${py}px`;
                self.frameEle.style.left = `${px}px`;
              } else {
                // This is a resize event. Based on which handle has been dragged, we must expand the drag frame size as we move the handle,
                // keeping a min and max size constraint in play (based on the drag directive's min size and parent container size). Also,
                // if an aspect ratio has been imposed, we must pin the drag frame to this aspect ratio as we expand.
                let newRight: number;
                let newTop: number;
                let newLeft: number;
                let newBottom: number;
                let newHeight = self.frameHeight;
                let newWidth = self.frameWidth;
                let actualYAdj: number;
                let actualXAdj: number;
                let py = self.frameY;
                let px = self.frameX;

                switch (self.ActiveHandle?.appDragHandle) {
                  case 'resize-ne':
                    // Resizing northeast. Grow the top and the right edges of the drag frame as the mouse moves. The height and width will change
                    // by frameHeight + dy, frameWidth + dx accordingly. However, to maintain the illusion of resizing, we need to equivalently
                    // adjust the drag frame's top upwards by dy.
                    // Keep the y coord inside of the parent's container box.
                    py = self.Clamp(
                      self.frameY + dy,
                      0,
                      self.containerRect.height - 1
                    );
                    actualYAdj = self.frameY - py;
                    newHeight = self.frameHeight + actualYAdj;

                    // Is this new height below the allowed minimum for the drag frame? If so, put the new height back to the min allowed, and
                    // recalculate the new py coord.
                    if (newHeight < self.appDragMinHeight) {
                      newHeight = self.appDragMinHeight;
                      py = self.frameY + self.frameHeight - newHeight;
                    }

                    // Ensure that the drag frame's right side remains within the parent's container box.
                    newRight = self.Clamp(
                      self.frameX + self.frameWidth - 1 + dx,
                      0,
                      self.containerEle.clientWidth - 1
                    );
                    actualXAdj = newRight - self.frameX + 1 - self.frameWidth;

                    newWidth = Math.max(
                      self.frameWidth + actualXAdj,
                      self.appDragMinWidth
                    );
                    break;
                  case 'resize-se':
                    // Resizing southeast. Grow the bottom and right edges.
                    newBottom = self.Clamp(
                      self.frameY + self.frameHeight - 1 + dy,
                      self.frameY + self.appDragMinHeight - 1,
                      self.containerEle.clientHeight - 1
                    );

                    newHeight = newBottom - self.frameY + 1;

                    newRight = self.Clamp(
                      self.frameX + self.frameWidth - 1 + dx,
                      self.frameX + self.appDragMinWidth - 1,
                      self.containerEle.clientWidth - 1
                    );

                    newWidth = newRight - self.frameX + 1;

                    // Top/left does not change, only height and width.
                    break;
                  case 'resize-s':
                    // Resizing south. Grow the bottom edge.
                    newBottom = self.Clamp(
                      self.frameY + self.frameHeight - 1 + dy,
                      self.frameY + self.appDragMinHeight - 1,
                      self.containerEle.clientHeight - 1
                    );

                    newHeight = newBottom - self.frameY + 1;
                    break;
                  case 'resize-sw':
                    // Resizing southwest. Grow the bottom and left edges.
                    newBottom = self.Clamp(
                      self.frameY + self.frameHeight - 1 + dy,
                      self.frameY + self.appDragMinHeight - 1,
                      self.containerEle.clientHeight - 1
                    );

                    newHeight = newBottom - self.frameY + 1;

                    newRight = self.frameX + self.frameWidth - 1;
                    newLeft = self.Clamp(
                      self.frameX + dx,
                      0,
                      newRight - self.appDragMinWidth + 1
                    );

                    newWidth = newRight - newLeft + 1;
                    px = newLeft;
                    break;
                  case 'resize-e':
                    // Resizing east. Grow only the right edge of the frame.
                    newRight = self.Clamp(
                      self.frameX + self.frameWidth - 1 + dx,
                      0,
                      self.containerEle.clientWidth - 1
                    );

                    actualXAdj = newRight - self.frameX + 1 - self.frameWidth;

                    newWidth = Math.max(
                      self.frameWidth + actualXAdj,
                      self.appDragMinWidth
                    );

                    // No change in y/top coord, x/left coord, or height.
                    py = self.frameY;
                    px = self.frameX;
                    newHeight = self.frameHeight;
                    break;
                  case 'resize-w':
                    // Resizing west. Grow only the left edge of the frame.
                    newRight = self.frameX + self.frameWidth - 1;
                    newLeft = self.Clamp(
                      self.frameX + dx,
                      0,
                      newRight - self.appDragMinWidth + 1
                    );

                    newWidth = newRight - newLeft + 1;
                    px = newLeft;

                    // No change in y/top coord or height.
                    py = self.frameY;
                    newHeight = self.frameHeight;
                    break;
                  case 'resize-nw':
                    // Resizing northwest. Grow only the top and left edges of the frame.

                    newBottom = self.frameY + self.frameHeight - 1;
                    newTop = self.Clamp(
                      self.frameY + dy,
                      0,
                      newBottom - self.appDragMinHeight + 1
                    );

                    newHeight = newBottom - newTop + 1;
                    py = newTop;

                    newRight = self.frameX + self.frameWidth - 1;
                    newLeft = self.Clamp(
                      self.frameX + dx,
                      0,
                      newRight - self.appDragMinWidth + 1
                    );

                    newWidth = newRight - newLeft + 1;
                    px = newLeft;
                    break;
                  case 'resize-n':
                    // Resizing north. Grow only the top edge of the frame.
                    newBottom = self.frameY + self.frameHeight - 1;
                    newTop = self.Clamp(
                      self.frameY + dy,
                      0,
                      newBottom - self.appDragMinHeight + 1
                    );

                    newHeight = newBottom - newTop + 1;
                    py = newTop;
                    break;
                }

                // Move and resize the drag frame accordingly.
                self.frameEle.style.top = `${py}px`;
                self.frameEle.style.left = `${px}px`;
                self.frameEle.style.width = `${newWidth}px`;
                self.frameEle.style.height = `${newHeight}px`;
              }
            }),
            takeUntil(
              $mouseup!.pipe(
                tap((event) => {
                  console.log('stopping drag');
                  // If this was a resize operation, now that we're done we need to lock in the new width/height of the drag frame.
                  if (self.ActiveHandle?.appDragHandle !== 'move') {
                    self.frameWidth = self.frameEle.offsetWidth;
                    self.frameHeight = self.frameEle.offsetHeight;
                  }

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
}
