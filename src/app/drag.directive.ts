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
  @Input() appDragAspectRatio: string = '1:1';

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
  private aspectX = 0;
  private aspectY = 0;
  private aspectLocked = false;

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

    // Determine if we are using an aspect ratio for this operation (assuming it will be a resize, at least).
    this.aspectLocked = !!this.appDragAspectRatio;
    if (this.aspectLocked) {
      // We need to parse out the aspect values so we can set the aspect ratio. If the format is invalid, we assume an error and just skip using an aspect ratio.
      const ratioParts = this.appDragAspectRatio.match(
        /^(\d+(?:\.\d*)?):(\d+(?:\.\d*)?)$/
      );
      if (ratioParts == null || ratioParts.length < 3) {
        // Invalid. Turn off aspect locking.
        this.aspectLocked = false;
      } else {
        this.aspectX = Number.parseFloat(ratioParts[1]);
        this.aspectY = Number.parseFloat(ratioParts[2]);
        if (Math.abs(this.aspectX) <= 1e-4 || Math.abs(this.aspectY) <= 1e-4) {
          this.aspectLocked = false;
        }
      }
    }
    if (!this.aspectLocked) {
      [this.aspectX, this.aspectY] = [0, 0];
    }
    console.log('aspect is: ', [this.aspectX, this.aspectY, this.aspectLocked]);
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
              console.log('--------------------------------------------------');

              // Calculate the offset between the start of the drag operation and the current mouse cursor position. This offset will be used for
              // all drag/resize operations.
              let [dx, dy] = [
                event.pageX - self.originX,
                event.pageY - self.originY,
              ];

              // If we are using aspect ratio locking, and this will be a resize event, we need to modify the (dx,dy) by the aspect ratio.
              if (
                self.aspectLocked &&
                self.ActiveHandle?.appDragHandle !== 'move'
              ) {
                // We adapt the aspect ratio with the following logic:
                // n or s only resize: apply the ratio to dy to get dx.
                // e or w only resize: apply the ratio to dx to get dy.
                // ne resize: if dx > 0 or dy < 0, use the larger one's absolute value as the basis for that direction, then apply to get the other.
                //    Otherwise, if both are negative, use the larger non-absolute value as the basis for that direction, then apply to get the other.
                // se resize: if dx > 0 or dy > 0, use the larger one's absolute value as basis.
                // sw resize: if dx < 0 or dy > 0, use the larger one's absolute value as basis.
                // nw resize: if dx < 0 or dy < 0, use the larger one's absolute value as basis.
                switch (self.ActiveHandle?.appDragHandle) {
                  case 'resize-e':
                    dy = -Math.floor((dx * self.aspectY) / self.aspectX);
                    break;
                }
              }

              // Variables used for calculating the new position and size of the drag frame/
              let newRight = self.frameX + self.frameWidth - 1;
              let newTop = self.frameY;
              let newLeft = self.frameX;
              let newBottom = self.frameY + self.frameHeight - 1;
              let newHeight = self.frameHeight; // As defaults, assume no change is performed.
              let newWidth = self.frameWidth;
              let py = self.frameY;
              let px = self.frameX;

              // Depending on the active handle's purpose, we either move the drag item, or we resize the drag frame in a certain
              // direction.
              if (self.ActiveHandle?.appDragHandle === 'move') {
                // This is a simple move/drag operation. We apply the (dx,dy) offset to the frame's original position to move it, but
                // we must be mindful of staying within the containing parent's space.
                newTop = self.Clamp(
                  self.frameY + dy,
                  0,
                  self.containerEle.clientHeight - 1
                );
                newLeft = self.Clamp(
                  self.frameX + dx,
                  0,
                  self.containerEle.clientWidth - 1
                );
                newRight = newLeft + self.frameWidth - 1;
                newBottom = newTop + self.frameHeight - 1;

                // Now, we check constraints on the right and bottom. If either is out of frame, we adjust the left and top (respectively) to
                // keep within frame.
                if (newRight >= self.containerEle.clientWidth) {
                  newLeft += self.containerEle.clientWidth - 1 - newRight;
                }
                if (newBottom >= self.containerEle.clientHeight) {
                  newTop += self.containerEle.clientHeight - 1 - newBottom;
                }

                px = newLeft;
                py = newTop;

                // Apply the (dx,dy) offset to the drag frame's initial upper-left (x,y) to get the new coords to move the drag frame to.
                // [px, py] = [self.frameX + dx, self.frameY + dy];

                // // To ensure we can't drag the drag frame out of the drag frame's containing parent element, we now clamp this (px, py) location
                // // to be within that container.
                // px = self.Clamp(
                //   px,
                //   0,
                //   self._appDragParent.offsetWidth -
                //     self._appDragParent.clientLeft -
                //     self.frameWidth
                // );
                // py = self.Clamp(
                //   py,
                //   0,
                //   self._appDragParent.offsetHeight -
                //     self._appDragParent.clientTop -
                //     self.frameHeight
                // );

                // // Now move the drag frame to these new coordinates.
                // self.frameEle.style.top = `${py}px`;
                // self.frameEle.style.left = `${px}px`;
              } else {
                // This is a resize event. Based on which handle has been dragged, we must expand the drag frame size as we move the handle,
                // keeping a min and max size constraint in play (based on the drag directive's min size and parent container size). Also,
                // if an aspect ratio has been imposed, we must pin the drag frame to this aspect ratio as we expand.

                // First, let's handle resizing along the east-west axis.
                switch (self.ActiveHandle?.appDragHandle) {
                  case 'resize-nw':
                  case 'resize-w':
                  case 'resize-sw':
                    newLeft = self.frameX + dx;

                    if (newLeft < 0) {
                      // User is expanding horiz axis too much. Clamp at 0, and optionally reset dx if we are aspect locked.
                      newLeft = 0;
                      if (
                        self.aspectLocked &&
                        self.ActiveHandle?.appDragHandle === 'resize-w'
                      ) {
                        dx = -self.frameX;
                      }
                    }

                    if (newLeft > newRight - self.appDragMinWidth + 1) {
                      // User is shrinking horiz axis too small. Clamp at the min, and optionally reset dx if we are aspect locked.
                      newLeft = newRight - self.appDragMinWidth + 1;
                      if (
                        self.aspectLocked &&
                        self.ActiveHandle?.appDragHandle === 'resize-w'
                      ) {
                        dx = newLeft - self.frameX;
                      }
                    }

                    newWidth = newRight - newLeft + 1;
                    px = newLeft;
                    console.log('Done moving to new px ' + px);
                    break;
                  case 'resize-se':
                  case 'resize-e':
                  case 'resize-ne':
                    newRight = self.frameX + self.frameWidth - 1 + dx;

                    if (newRight < self.frameX + self.appDragMinWidth - 1) {
                      // User is shrinking horiz axis too small. Clamp at the min, and optionally reset dx if we are aspect locked.
                      newRight = self.frameX + self.appDragMinWidth - 1;
                      if (
                        self.aspectLocked &&
                        self.ActiveHandle?.appDragHandle === 'resize-e'
                      ) {
                        dx = -(self.frameX + self.frameWidth - newRight);
                      }
                    }

                    if (newRight > self.containerEle.clientWidth - 1) {
                      // User is expanding horiz axis too much. Clamp at the max, and optionally reset dx if we are aspect locked.
                      newRight = self.containerEle.clientWidth - 1;
                      if (
                        self.aspectLocked &&
                        self.ActiveHandle?.appDragHandle === 'resize-e'
                      ) {
                        dx =
                          self.containerEle.clientWidth -
                          self.frameX -
                          self.frameWidth;
                      }
                    }

                    newWidth = newRight - self.frameX + 1;
                    break;
                }

                // Next, let's handle resizing along the north-south axis.
                switch (self.ActiveHandle?.appDragHandle) {
                  case 'resize-nw':
                  case 'resize-n':
                  case 'resize-ne':
                    newBottom = self.frameY + self.frameHeight - 1;
                    newTop = self.Clamp(
                      self.frameY + dy,
                      0,
                      newBottom - self.appDragMinHeight + 1
                    );

                    newHeight = newBottom - newTop + 1;
                    py = newTop;
                    break;
                  case 'resize-sw':
                  case 'resize-s':
                  case 'resize-se':
                    newBottom = self.Clamp(
                      self.frameY + self.frameHeight - 1 + dy,
                      self.frameY + self.appDragMinHeight - 1,
                      self.containerEle.clientHeight - 1
                    );

                    newHeight = newBottom - self.frameY + 1;
                    break;
                  case 'resize-e':
                  case 'resize-w':
                    // If we are aspect locked, we adjust now with half upwards and half downwards. One or both may be pinned in this attempt, though.
                    // We calculate where the top and bottom would like to be, see if we need to adjust an overage in either direction, and if necessary,
                    // we pull back the new width if we can't "spend" the full adjustment in the other direction.
                    if (self.aspectLocked) {
                      console.log('dx being adjusted by ', dx);
                      console.log('half height ' + self.frameHeight / 2);
                      console.log(
                        'half min height ' + self.appDragMinHeight / 2
                      );
                      console.log(
                        'available space: ' +
                          (self.frameHeight / 2 - self.appDragMinHeight / 2)
                      );

                      const isWest =
                        self.ActiveHandle?.appDragHandle === 'resize-w';
                      const isExpanding =
                        (!isWest && dx > 0) || (isWest && dx < 0);

                      let halfdyup =
                        Math.abs(dx / 2.0) * (isExpanding ? 1 : -1);
                      let halfdydown =
                        (Math.abs(dx) - Math.abs(halfdyup)) *
                        (isExpanding ? 1 : -1);

                      let spaceUp = isExpanding
                        ? self.frameY
                        : self.frameHeight / 2 - self.appDragMinHeight / 2;
                      let spaceDown = isExpanding
                        ? self.containerEle.clientHeight -
                          1 -
                          self.frameY -
                          self.frameHeight
                        : self.frameHeight / 2 - self.appDragMinHeight / 2;

                      let topPinned = false,
                        botPinned = false;
                      let overage = 0;
                      let breakOut = false;
                      let allocated = 0;

                      console.log(
                        `moving ${
                          self.ActiveHandle?.appDragHandle === 'resize-e'
                            ? 'right'
                            : 'left'
                        } with halfdydown = ${halfdydown}`
                      );

                      while (!(topPinned && botPinned) && !breakOut) {
                        breakOut = true; // Assume we will be okay on this pass.

                        if (Math.abs(halfdyup) > 1e-4) {
                          // We need to either expand upwards (halfdyup > 0) or contract downards (halfdyup < 0). Try to do all of it now.
                          overage = Math.abs(halfdyup) - spaceUp;
                          if (overage > 0) {
                            // We were unable to allocate/shrink all space to/from the top. If we're not yet top pinned, flag it now and move the balance
                            // to the bottom.
                            if (!topPinned) {
                              halfdydown += halfdyup > 0 ? overage : -overage;
                              overage = 0;
                              newTop += halfdyup > 0 ? -spaceUp : spaceUp;
                              allocated += spaceUp;
                              halfdyup = 0; // Reset, as we cannot move any more upwards.
                              spaceUp = 0;
                              topPinned = true;
                              breakOut = false;
                            }
                          } else {
                            // We allocated/shrank all of the needed space. Adjust parameters.
                            console.log(
                              'allocated total of ' + halfdyup + ' to top'
                            );
                            allocated += halfdyup;
                            newTop += -halfdyup;
                            spaceUp += halfdyup > 0 ? -halfdyup : halfdyup;
                            halfdyup = 0;
                          }
                        }

                        if (Math.abs(halfdydown) > 1e-4) {
                          // We have a need to expand/contract the bottom edge. Try to do it all down now.
                          overage = Math.abs(halfdydown) - spaceDown;
                          if (overage > 0) {
                            // We were unable to allocate/contract all space to the bottom. If we're not yet bottom pinned, flag it now and move the balance
                            // to the top.
                            if (!botPinned) {
                              console.log(
                                'Have to move ' +
                                  overage +
                                  ' from bottom to top'
                              );
                              halfdyup += halfdydown > 0 ? overage : -overage;
                              overage = 0;
                              allocated += spaceDown;
                              newBottom +=
                                halfdydown > 0 ? spaceDown : -spaceDown;
                              spaceDown = 0;
                              halfdydown = 0; // Reset, as we cannot move any more downards.
                              botPinned = true;
                              breakOut = false;
                            }
                          } else {
                            // We allocated all of the needed space. Adjust parameters.
                            console.log(
                              'allocated total of ' + halfdydown + ' to bottom'
                            );
                            newBottom += halfdydown;
                            allocated += halfdydown;
                            spaceDown +=
                              halfdydown > 0 ? -halfdydown : halfdydown;
                            halfdydown = 0;
                          }
                        }
                      }

                      if (topPinned && botPinned) {
                        console.log('both pinned');
                        // Both the top and the bottom are pinned. That means we may not have been able to apportion the full dx amount in the vertical
                        // direction. If we didn't, we need to "pull back" the dx expansion to keep in aspect ratio.
                        overage = Math.abs(dx) - Math.abs(allocated);
                        if (overage > 0) {
                          // Pull back by the overage amount.
                          console.log('Must reduce width by ', overage);
                          if (isWest) {
                            console.log(
                              'moving left edge back to the right by ' + overage
                            );
                            newLeft += overage;
                            newWidth -= overage;
                            px = newLeft;
                          } else {
                            console.log('reducing width by ' + overage);
                            newWidth -= overage;
                          }
                        }
                      }

                      // Set the height now accordingly.
                      // newTop = self.frameY - halfdyup;
                      // newBottom = self.frameY + self.frameHeight + halfdydown;
                      newHeight = newBottom - newTop + 1;
                      py = newTop;
                    }
                    break;
                }
              }

              // Move and resize the drag frame accordingly.
              self.frameEle.style.top = `${py}px`;
              self.frameEle.style.left = `${px}px`;
              self.frameEle.style.width = `${newWidth}px`;
              self.frameEle.style.height = `${newHeight}px`;
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
