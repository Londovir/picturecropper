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
  @Input() appDragMinHeight: number = 100;
  @Input() appDragAspectRatio: string = '1:2';

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
  private x1: number;
  private y1: number;
  private x2: number;
  private y2: number;
  private x1_int: number;
  private y1_int: number;
  private width_int: number;
  private height_int: number;
  private lastx: number;
  private lasty: number;
  private x: number;
  private y: number;
  private width: number;
  private height: number;
  private aspect_numerator: number;
  private aspect_denominator: number;

  private frameRect: DOMRect;
  private containerRect: DOMRect;
  private dragZone: Rectangle = { x1: 0, y1: 0, x2: 0, y2: 0 };
  private frameStart: FramePosition = {
    Left: 0,
    Top: 0,
    CenterX: 0,
    CenterY: 0,
    Right: 0,
    Bottom: 0,
    Width: 0,
    Height: 0,
  };
  private parentStart: FramePosition = {
    Left: 0,
    Top: 0,
    CenterX: 0,
    CenterY: 0,
    Right: 0,
    Bottom: 0,
    Width: 0,
    Height: 0,
  };
  private cursorStart: CursorPosition = { x: 0, y: 0 };
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
    this.frameStart = {
      Top: this.frameEle.offsetTop,
      Left: this.frameEle.offsetLeft,
      CenterX:
        (2 * this.frameEle.offsetTop + this.frameEle.offsetWidth - 1) / 2,
      CenterY:
        (2 * this.frameEle.offsetTop + this.frameEle.offsetHeight - 1) / 2,
      Right: this.frameEle.offsetLeft + this.frameEle.offsetWidth - 1,
      Bottom: this.frameEle.offsetTop + this.frameEle.offsetHeight - 1,
      Width: this.frameEle.offsetWidth,
      Height: this.frameEle.offsetHeight,
    }; // Capture the width and height of the drag frame.

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

  // #region Calculate Frame Box For Center Handle

  CalculateFrameBoxForCenterHandles(setup: FrameProblem): FramePosition {
    const self = this;
    let dx = setup.DX;
    let dy = setup.DY;
    const maxX = setup.ParentWidth - 1;
    const maxY = setup.ParentHeight - 1;
    const origWidth = setup.OrigWidth;
    const origHeight = setup.OrigHeight;
    const origLeft = setup.OrigLeft;
    const origRight = origLeft + origWidth;
    const origTop = setup.OrigTop;

    let spaceX: number, spaceY: number, stepsX: number, stepsY: number;
    let newWidth = origWidth,
      newHeight = origHeight,
      newTop = origTop,
      newLeft = origLeft;

    spaceX = maxX - origRight;
    spaceY = maxY - origHeight;

    if (dx < 0) {
      // This is a contraction. All we have to worry about is
      // maintaining a minimum width/height.
      dx *= -1;
      spaceX = origWidth - self.appDragMinWidth;
      spaceY = origHeight - self.appDragMinHeight;
      dy = Math.floor((dx * self.aspectY) / self.aspectX);
      if (dx > spaceX || dy > spaceY) {
        // Calculate the # of "steps" needed for either/both directions to max out.
        stepsX = dx > spaceX ? spaceX / dx : +Infinity;
        stepsY = dy > spaceY ? spaceY / dy : +Infinity;

        if (stepsX < stepsY) {
          // The width hits the min first. Set min width, then adjust height accordingly.
          newWidth = self.appDragMinWidth;
          newHeight = Math.floor((newWidth * self.aspectY) / self.aspectX);
          newTop = origTop + Math.floor((origHeight - newHeight) / 2);
        } else {
          // The height his the min first. Set min height, then adjust width accordingly.
          newHeight = self.appDragMinHeight;
          newWidth = Math.floor((newHeight * self.aspectX) / self.aspectY);
          newTop = origTop + Math.floor((origHeight - newHeight) / 2);
        }
      } else {
        // Simple contraction, no restriction.
        newWidth = origWidth - dx;
        newHeight = origHeight - dy;
        newTop = origTop + Math.floor(dy / 2);
      }
    } else {
      // This is an expansion. Let's check the expansion rates against the available
      // horiz. and vert. space. If either is over, it means we must deal with container collisions.
      dy = Math.floor((dx * self.aspectY) / self.aspectX);
      if (dx > spaceX || dy > spaceY) {
        // Calculate the # of "steps" needed for either/both directions to max out.
        stepsX = dx > spaceX ? spaceX / dx : +Infinity;
        stepsY = dy > spaceY ? spaceY / dy : +Infinity;

        if (stepsX < stepsY) {
          // The E/W axis runs out first. Max the expansion to that wall, then split out the equal expansion to the N/S axis.
          newWidth = origWidth + spaceX;
          newHeight = Math.floor((newWidth * self.aspectY) / self.aspectX);
          spaceY = Math.floor((spaceX * self.aspectY) / self.aspectX);
          stepsY = Math.floor(spaceY / 2);
          newTop = Math.max(origTop - stepsY, 0);
          if (newTop + newHeight > maxY) {
            stepsY = newTop + newHeight - maxY;
            newTop -= stepsY;
          }
        } else {
          // The N/S axis runs out first. Max the expansion to both walls, then move the E axis the same amount.
          newHeight = origHeight + spaceY;
          newTop = 0;
          spaceX = Math.floor((spaceY * self.aspectX) / self.aspectY);
          newWidth = origWidth + spaceX;
        }
      } else {
        // No colision. Simple expansion.
        newWidth = origWidth + dx;
        newHeight = Math.floor((newWidth * self.aspectY) / self.aspectX);
        stepsY = Math.floor(dy / 2);
        newTop = Math.max(origTop - stepsY, 0);
        if (newTop + newHeight > maxY) {
          stepsY = newTop + newHeight - maxY;
          newTop -= stepsY;
        }
      }
    }

    return {
      Top: newTop,
      Left: newLeft,
      Width: newWidth,
      Height: newHeight,
    } as FramePosition;
  }

  // #endregion

  // #region Calculate Frame Box For Corner Handle

  CalculateFrameBoxForCornerHandles(setup: FrameProblem): FramePosition {
    const self = this;
    let dx = setup.DX;
    let dy = setup.DY;
    const maxX = setup.ParentWidth - 1;
    const maxY = setup.ParentHeight - 1;
    const origWidth = setup.OrigWidth;
    const origHeight = setup.OrigHeight;
    const origLeft = setup.OrigLeft;
    const origRight = origLeft + origWidth - 1;
    const origTop = setup.OrigTop;

    let spaceX: number, spaceY: number, stepsX: number, stepsY: number;
    let newWidth = origWidth,
      newHeight = origHeight,
      newTop = origTop,
      newLeft = origLeft;

    spaceX = maxX - origRight;
    spaceY = origTop;

    if (dx < 0) {
      // This is a contraction. All we have to worry about is
      // maintaining a minimum width/height.
      dx *= -1;
      spaceX = origWidth - self.appDragMinWidth;
      spaceY = origHeight - self.appDragMinHeight;
      dy = Math.floor((dx * setup.AspectY) / setup.AspectX);
      if (dx > spaceX || dy > spaceY) {
        // Calculate the # of "steps" needed for either/both directions to max out.
        stepsX = dx > spaceX ? spaceX / dx : +Infinity;
        stepsY = dy > spaceY ? spaceY / dy : +Infinity;

        if (stepsX < stepsY) {
          // The width hits the min first. Set min width, then adjust height accordingly.
          newWidth = self.appDragMinWidth;
          newHeight = Math.floor((newWidth * setup.AspectY) / setup.AspectX);
          newTop = origTop + Math.floor(origHeight - newHeight);
        } else {
          // The height his the min first. Set min height, then adjust width accordingly.
          newHeight = self.appDragMinHeight;
          newWidth = Math.floor((newHeight * setup.AspectX) / setup.AspectY);
          newTop = origTop + Math.floor(origHeight - newHeight);
        }
      } else {
        // Simple contraction, no restriction.
        newWidth = origWidth - dx;
        newHeight = origHeight - dy;
        newTop = origTop + dy;
      }
    } else {
      // This is an expansion. Let's check the expansion rates against the available
      // horiz. and vert. space. If either is over, it means we must deal with container collisions.
      dy = Math.floor((dx * setup.AspectY) / setup.AspectX);
      if (dx > spaceX || dy > spaceY) {
        // Calculate the # of "steps" needed for either/both directions to max out.
        stepsX = dx > spaceX ? spaceX / dx : +Infinity;
        stepsY = dy > spaceY ? spaceY / dy : +Infinity;

        if (stepsX < stepsY) {
          // The E/W axis runs out first. Max the expansion to that wall, then split out the equal expansion to the N/S axis.
          newWidth = origWidth + spaceX;
          newHeight = Math.round((newWidth * setup.AspectY) / setup.AspectX);
          newTop = Math.max(origTop - (newHeight - origHeight), 0);
        } else {
          // The N/S axis runs out first. Max the expansion to both walls, then move the E axis the same amount.
          newHeight = origHeight + spaceY;
          newTop = 0;
          spaceX = Math.floor((spaceY * setup.AspectX) / setup.AspectY);
          newWidth = origWidth + spaceX;
        }
      } else {
        // No colision. Simple expansion.
        newWidth = origWidth + dx;
        newHeight = Math.floor((newWidth * setup.AspectY) / setup.AspectX);
        newTop = Math.max(origTop - dy, 0);
      }
    }

    return {
      Top: newTop,
      Left: newLeft,
      Width: newWidth,
      Height: newHeight,
    } as FramePosition;
  }

  // #endregion

  // #region Clamp

  Clamp(num: number, min: number, max: number) {
    // Ensure the input value num is restricted to the range [min, max]
    return Math.max(Math.min(num, max), min);
  }

  // #endregion

  // #region Clamp To Parent

  ClampToParent(
    frame: FramePosition,
    parent: FramePosition,
    sidesToClamp: number
  ) {
    // First, we need to clamp the horiz. axis.
    if (frame.Left < 0) {
      const dx = -frame.Left;
      frame.Left += dx;

      if (frame.Right < 0) {
        frame.Right = 0;
      }

      sidesToClamp |= ClampDirection.CLAMP_LEFT;
    }

    if (frame.Right > parent.Width - 1) {
      const dx = parent.Width - frame.Right;
      frame.Right += dx;

      if (frame.Left > parent.Width - 1) {
        frame.Left = parent.Width - 1;
      }

      sidesToClamp |= ClampDirection.CLAMP_RIGHT;
    }

    // Now, clamp the vert. axis.
    if (frame.Top < 0) {
      const dy = -frame.Top;
      frame.Top += dy;

      if (frame.Bottom < 0) {
        frame.Bottom = 0;
      }

      sidesToClamp |= ClampDirection.CLAMP_TOP;
    }

    if (frame.Bottom > parent.Height - 1) {
      const dy = parent.Height - frame.Bottom;
      frame.Bottom += dy;

      if (frame.Top > parent.Height - 1) {
        frame.Top = parent.Height - 1;
      }

      sidesToClamp |= ClampDirection.CLAMP_BOTTOM;
    }

    frame.Width = frame.Right - frame.Left;
    frame.Height = frame.Bottom - frame.Top;
    frame.CenterX = Math.floor((frame.Left + frame.Right) / 2);
    frame.CenterY = Math.floor((frame.Top + frame.Bottom) / 2);

    return sidesToClamp;
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

          this.rectangle_setup_snap_offsets (rectangle, coords);
        this.widget_get_snap_offsets (widget, &snap_x, &snap_y, NULL, NULL);

      let snapped_x = coords.x + snap_x;
    let snapped_y = coords.y + snap_y;

  rectangle.lastx = snapped_x;
  rectangle.lasty = snapped_y;

  if (rectangle.function == ResizingFunction.CREATING)
    {
      /* Remember that this rectangle was created from scratch. */
      rectangle.is_new = true;

      rectangle.x1 = rectangle.x2 = snapped_x;
      rectangle.y1 = rectangle.y2 = snapped_y;

      /* Unless forced, created rectangles should not be started in
       * narrow-mode
       */
      if (rectangle.force_narrow_mode)
        rectangle.narrow_mode = TRUE;
      else
        rectangle.narrow_mode = FALSE;

      /* If the rectangle is being modified we want the center on
       * fixed_center to be at the center of the currently existing
       * rectangle, otherwise we want the point where the user clicked
       * to be the center on fixed_center.
       */
      rectangle.center_x_on_fixed_center = snapped_x;
      rectangle.center_y_on_fixed_center = snapped_y;

      /* When the user toggles modifier keys, we want to keep track of
       * what coordinates the "other side" should have. If we are
       * creating a rectangle, use the current mouse coordinates as
       * the coordinate of the "other side", otherwise use the
       * immediate "other side" for that.
       */
      rectangle.other_side_x = snapped_x;
      rectangle.other_side_y = snapped_y;
    }
  else
    {
      /* This rectangle was not created from scratch. */
      rectangle.is_new = FALSE;

      rectangle.center_x_on_fixed_center = (rectangle.x1 + rectangle.x2) / 2;
      rectangle.center_y_on_fixed_center = (rectangle.y1 + rectangle.y2) / 2;

      // TODO: x and y passed by reference
      const rectcoords = this.rectangle_get_other_side_coord (rectangle,
                                                 other_side_x,
                                                other_side_y);

        rectangle.other_size_x = rectcoord.other_side_x;
        rectangle.other_side_y = rectcoord.other_side_y;
    }

  this.rectangle_update_int_rect (rectangle);

  /* Is the rectangle being rubber-banded? */
  rectangle.rect_adjusting = this.rectangle_rect_adjusting_func (rectangle);

  this.rectangle_changed (widget);

  this.rectangle_update_status (rectangle);

        }),
        // Use switchMap to change over from working with mousedown observables to working with mousemove observables, so we
        // can track the progress of the mouse cursor as we're engaged in this drag/resize.
        switchMap(() =>
          $mousemove!.pipe(
            tap((event) => {
              // self.HandleDragMove2(event);
              this.rectangle_update_with_coord(rectangle, this.dragType, event.clientX, event.clientY);

              this.rectangle_update_status(rectangle);

              if (rectange.function === ResizingFunction.CREATING) {
                let dx = event.clientX - rectangle.lastx;
                let dy = event.clientY - rectangle.liasty;

                /* When the user starts to move the cursor, set the current
       * function to one of the corner-grabbed functions, depending on
       * in what direction the user starts dragging the rectangle.
       */
      let rfunction: ResizingFunction;

      if (dx < 0)
        {
          rfunction = (dy < 0 ?
                      ResizingFunction.RESIZING_UPPER_LEFT :
                      ResizingFunction.RESIZING_LOWER_LEFT);
        }
      else if (dx > 0)
        {
          rfunction = (dy < 0 ?
                      ResizingFunction.RESIZING_UPPER_RIGHT :
                      ResizingFunction.RESIZING_LOWER_RIGHT);
        }
      else if (dy < 0)
        {
          rfunction = (dx < 0 ?
                      ResizingFunction.RESIZING_UPPER_LEFT :
                      ResizingFunction.RESIZING_UPPER_RIGHT);
        }
      else if (dy > 0)
        {
          rfunction = (dx < 0 ?
                      ResizingFunction.RESIZING_LOWER_LEFT :
                      ResizingFunction.RESIZING_LOWER_RIGHT);
        }

        this.rectangle_set_function (rectangle, rfunction);

        if (rectangle.fixed_rule_active &&
          rectangle.fixed_rule == GIMP_RECTANGLE_FIXED_SIZE)
        {
          /* For fixed size, set the function to moving immediately since the
           * rectangle can not be resized anyway.
           */

          /* We fake a coord update to get the right size. */
          this.rectangle_update_with_coord (rectangle,
                                                 event.clientX,
                                                 event.clientY);

          gimp_tool_widget_set_snap_offsets (widget,
                                             -(private->x2 - private->x1) / 2,
                                             -(private->y2 - private->y1) / 2,
                                             private->x2 - private->x1,
                                             private->y2 - private->y1);

          gimp_tool_rectangle_set_function (rectangle,
                                            GIMP_TOOL_RECTANGLE_MOVING);
        }


        rectangle_update_options (rectangle);

  private->lastx = snapped_x;
  private->lasty = snapped_y;




              }




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

  // #region Handle Drag Move

  HandleDragMove2(event: MouseEvent) {
    const self = this;
    let resizeDirection: ResizeDirection = ResizeDirection.RESIZE_NONE;
    let usedClamping: number = 0;

    if (!self._appDragParent || !self.ActiveHandle?.appDragHandle) return;
    const dragType = self.ActiveHandle?.appDragHandle || '';

    // Calculate the offset between the start of the drag operation and the current mouse cursor position. This offset will be used for
    // all drag/resize operations.
    let [dx, dy] = [
      event.clientX - self.cursorStart.x,
      event.clientY - self.cursorStart.y,
    ];

    // Variables used for calculating the new position and size of the drag frame/
    // let origRight = self.frameX + self.frameWidth - 1,
    //   newRight = self.frameX + self.frameWidth - 1;
    // let origTop = self.frameY,
    //   newTop = self.frameY;
    // let origLeft = self.frameX,
    //   newLeft = self.frameX;
    // let origBottom = self.frameY + self.frameHeight - 1,
    //   newBottom = self.frameY + self.frameHeight - 1;
    // let origHeight = self.frameHeight,
    //   newHeight = self.frameHeight; // As defaults, assume no change is performed.
    // let origWidth = self.frameWidth,
    //   newWidth = self.frameWidth;

    let result: FramePosition = {
      Top: self.frameStart.Top,
      Left: self.frameStart.Left,
      CenterX: (2 * self.frameStart.Left + self.frameStart.Width) / 2,
      CenterY: (2 * self.frameStart.Top + self.frameStart.Height) / 2,
      Bottom: self.frameStart.Top + self.frameStart.Height,
      Right: self.frameStart.Left + self.frameStart.Width,
      Height: self.frameStart.Height,
      Width: self.frameStart.Width,
    };

    // Depending on the active handle's purpose, we either move the drag item, or we resize the drag frame in a certain
    // direction.
    if (dragType === 'move') {
      // This is a simple move/drag operation. We apply the (dx,dy) offset to the frame's original position to move it, but
      // we must be mindful of staying within the containing parent's space.
      // result.Top += dy;
      // result.Left += dx;
      // result.Bottom += dy;
      // result.Right += dx;
      console.log(
        `Old cen: (${result.CenterX}, ${result.CenterY}), move by dx = ${dx}, dy = ${dy}`
      );
      result.CenterX += dx;
      result.CenterY += dy;

      result.Top = Math.floor(result.CenterY - result.Height / 2);
      result.Bottom = result.Top + result.Height;
      result.Left = Math.floor(result.CenterX - result.Width / 2);
      result.Right = result.Left + result.Width;

      // Constrain frame to be inside of the parent container.
      self.KeepFrameInsideParent(result, this.parentStart);
    } else {
      // This is a resize event. Based on which handle has been dragged, we must expand the drag frame size as we move the handle,
      // keeping a min and max size constraint in play (based on the drag directive's min size and parent container size). Also,
      // if an aspect ratio has been imposed, we must pin the drag frame to this aspect ratio as we expand.
      switch (dragType) {
        case 'resize-ne':
          resizeDirection = ResizeDirection.RESIZE_NORTHEAST;
          if (dx === 0 && dy === 0) break;

          result.Top += dy;
          result.Right += dx;
          break;
        case 'resize-se':
          // Southeast expansion requires rotating by 90 degrees counter-clockwise, then rotating back.
          resizeDirection = ResizeDirection.RESIZE_SOUTHEAST;
          if (dx === 0 && dy === 0) break;

          result.Bottom += dy;
          result.Right += dx;
          break;
        case 'resize-sw':
          // Southwest expansion requires mirroring across both axes, then mirroring back.
          resizeDirection = ResizeDirection.RESIZE_SOUTHWEST;
          if (dx === 0 && dy === 0) break;

          result.Left += dx;
          result.Bottom += dy;
          break;
        case 'resize-nw':
          // Northwest expansion requires rotating by 90 degrees clockwise, then rotating back.
          resizeDirection = ResizeDirection.RESIZE_NORTHWEST;
          if (dx === 0 && dy === 0) break;

          result.Left += dx;
          result.Top += dy;
          break;
        case 'resize-e':
          // If there is no adjustment in either direction, break immediately.
          resizeDirection = ResizeDirection.RESIZE_EAST;
          if (dx === 0 && dy === 0) break;

          result.Right += dx;
          break;
        case 'resize-w':
          // Reflect the problem E/W, use the solver, then reflect solution back out.
          resizeDirection = ResizeDirection.RESIZE_WEST;
          if (dx === 0 && dy === 0) break;

          result.Left += dx;

          break;
        case 'resize-n':
          // Rotate the problem 90 deg clockwise, then rotate solution back to the left.
          resizeDirection = ResizeDirection.RESIZE_NORTH;
          if (dx === 0 && dy === 0) break;

          result.Top += dy;

          break;
        case 'resize-s':
          // Rotate the problem 90 deg counter-clockwise, then rotate solution back to the right.
          resizeDirection = ResizeDirection.RESIZE_SOUTH;
          if (dx === 0 && dy === 0) break;

          result.Bottom += dy;

          break;
      }

      result.Width = result.Right - result.Left;
      result.Height = result.Bottom - result.Top;

      // Are we too small? If so, clamp at the min size allowed. If aspect locked, adjust as needed.
      if (result.Width < self.appDragMinWidth) {
        console.log('case 1');
        result.Width = self.appDragMinWidth;
        if (
          ![
            ResizeDirection.RESIZE_NORTHEAST,
            ResizeDirection.RESIZE_SOUTHEAST,
            ResizeDirection.RESIZE_EAST,
          ].includes(resizeDirection)
        ) {
          result.Left = result.Right - self.appDragMinWidth;
        }
        if (self.aspectLocked) {
          result.Height = (result.Width * self.aspectY) / self.aspectX;
          if (
            resizeDirection === ResizeDirection.RESIZE_EAST ||
            resizeDirection == ResizeDirection.RESIZE_WEST
          ) {
            result.Top = Math.floor(result.CenterY - result.Height / 2);
          } else if (
            resizeDirection === ResizeDirection.RESIZE_NORTHEAST ||
            resizeDirection === ResizeDirection.RESIZE_NORTHWEST
          ) {
            result.Top = result.Bottom - result.Height;
          } else {
            result.Bottom = result.Top + result.Height;
          }
        }
      } else if (result.Height < self.appDragMinHeight) {
        console.log('case 2');
        result.Height = self.appDragMinHeight;
        if (
          ![
            ResizeDirection.RESIZE_NORTHEAST,
            ResizeDirection.RESIZE_SOUTHEAST,
            ResizeDirection.RESIZE_SOUTH,
          ].includes(resizeDirection)
        ) {
          result.Top = result.Bottom - self.appDragMinHeight;
        }
        if (resizeDirection === ResizeDirection.RESIZE_NORTHEAST) {
          result.Top = result.Bottom - result.Height;
        } else {
          result.Bottom = result.Top + result.Height;
        }
        if (self.aspectLocked) {
          result.Width = (result.Height * self.aspectX) / self.aspectY;
          if (
            resizeDirection === ResizeDirection.RESIZE_NORTH ||
            resizeDirection === ResizeDirection.RESIZE_SOUTH
          ) {
            result.Left = Math.floor(result.CenterX - result.Width / 2);
          } else if (resizeDirection === ResizeDirection.RESIZE_SOUTHWEST) {
            result.Left = result.Right - result.Width;
          } else {
            result.Right = result.Left + result.Width;
          }
        }
      } else {
        // If we are aspect locked, now we must adjust the dimensions to maintain aspect.
        if (self.aspectLocked) {
          self.MaintainAspectRatio(
            result,
            this.parentStart,
            resizeDirection,
            usedClamping
          );

          if (result.Right - result.Left !== result.Width) {
            console.log(
              'Mismatch in dimensions: ',
              JSON.parse(JSON.stringify(result))
            );
          }

          // This adjustment may have moved something out of the parent container. Thus, we clamp again to ensure it is fit.
          usedClamping = self.ClampToParent(
            result,
            this.parentStart,
            usedClamping
          );

          if (result.Right - result.Left !== result.Width) {
            console.log(
              'Mismatch in dimensions 2: ',
              JSON.parse(JSON.stringify(result))
            );
          }

          console.log('Clamping is now: ', usedClamping);
          console.log('event x = ' + event.clientX);

          // And the clamp may, too, have messed up the aspect ratio when it shrank or expanded to fit the parent, so apply the maintainance one last time.
          self.MaintainAspectRatio(
            result,
            this.parentStart,
            resizeDirection,
            usedClamping
          );

          if (result.Right - result.Left !== result.Width) {
            console.log(
              'Mismatch in dimensions 3: ',
              JSON.parse(JSON.stringify(result))
            );
          }
        }
      }
    }

    result.CenterX = (result.Left + result.Right) / 2;
    result.CenterY = (result.Top + result.Bottom) / 2;

    // Move and resize the drag frame accordingly.
    self.frameEle.style.top = `${result.Top}px`;
    self.frameEle.style.left = `${result.Left}px`;
    self.frameEle.style.width = `${result.Width}px`;
    self.frameEle.style.height = `${result.Height}px`;

    // Update our tracking variables.
    // self.frameStart = {
    //   Top: result.Top,
    //   Left: result.Left,
    //   Right: result.Right,
    //   Bottom: result.Bottom,
    //   Width: result.Width,
    //   Height: result.Height,
    // };

    // If the cursor position is outside of the drag zone, clamp it accordingly if we are moving, else leave it alone.
    if (dragType === 'move') {
      // self.cursorStart = {
      //   x: self.Clamp(event.clientX, this.dragZone.x1, this.dragZone.x2),
      //   y: self.Clamp(event.clientY, this.dragZone.y1, this.dragZone.y2),
      // };
    } else {
      // self.cursorStart = { x: event.clientX, y: event.clientY };
    }
  }

  // #endregion

  // #region Keep Frame Inside Parent

  KeepFrameInsideParent(frame: FramePosition, parent: FramePosition) {
    // First, check the horiz. If the width of the frame is larger than the available parent width, force the frame to be contained within.
    if (frame.Right - frame.Left > parent.Width) {
      frame.Left = 0;
      frame.Right = parent.Width - 1;
      frame.Width = frame.Right - frame.Left + 1;
    } else {
      if (frame.Left < 0) {
        const dx = -frame.Left;
        frame.Left += dx;
        frame.Right += dx;
      }
      if (frame.Right > parent.Width - 1) {
        const dx = parent.Width - frame.Right;
        frame.Left += dx;
        frame.Right += dx;
      }
    }

    // Now, check the vert.
    if (frame.Height > parent.Height) {
      frame.Top = 0;
      frame.Bottom = parent.Height - 1;
      frame.Height = frame.Bottom - frame.Top + 1;
    } else {
      if (frame.Top < 0) {
        const dy = -frame.Top;
        frame.Top += dy;
        frame.Bottom += dy;
      }
      if (frame.Bottom > parent.Height - 1) {
        const dy = parent.Height - frame.Bottom;
        frame.Top += dy;
        frame.Bottom += dy;
      }
    }

    frame.CenterX = Math.floor((frame.Left + frame.Right) / 2);
    frame.CenterY = Math.floor((frame.Top + frame.Bottom) / 2);
  }

  // #endregion

  // #region Maintain Aspect Ratio

  MaintainAspectRatio(
    frame: FramePosition,
    parent: FramePosition,
    resizeDirection: ResizeDirection | null,
    usedClamping: number
  ) {
    const self = this;

    // Calculate the current aspect ratio and the desired one.
    const currentAspect = frame.Width / frame.Height;
    const desiredAspect = self.aspectX / self.aspectY;

    // If the current and desired aspect rations are sufficiently close numerically, leave it alone.
    if (Math.abs(currentAspect - desiredAspect) <= 1e-4) return;
    let sideToMove: SideAdjust = SideAdjust.SIDE_NONE;

    if (currentAspect > desiredAspect) {
      console.log(
        `case 1: frame top = ${frame.Top}, left = ${frame.Left}, right = ${frame.Right}, bottom = ${frame.Bottom}, width = ${frame.Width}, height = ${frame.Height}`
      );
      // The current sizing has the width be too much. If the top or bottom (as appropriate) are not clamped, we can simply
      // resize the height in that direction until the height brings the current aspect ratio back into alignment. Otherwise, we
      // opt to reduce the width by moving in the left or right (as appropriate) instead.
      switch (resizeDirection) {
        case ResizeDirection.RESIZE_NORTHWEST:
          if (!(usedClamping & ClampDirection.CLAMP_TOP)) {
            sideToMove = SideAdjust.SIDE_TOP;
          } else {
            sideToMove = SideAdjust.SIDE_LEFT;
          }
          break;
        case ResizeDirection.RESIZE_NORTH:
        case ResizeDirection.RESIZE_SOUTH:
          sideToMove = SideAdjust.SIDE_LEFT_RIGHT_SAME;
          break;
        case ResizeDirection.RESIZE_NORTHEAST:
          if (!(usedClamping & ClampDirection.CLAMP_TOP)) {
            sideToMove = SideAdjust.SIDE_TOP;
          } else {
            sideToMove = SideAdjust.SIDE_RIGHT;
          }
          break;
        case ResizeDirection.RESIZE_EAST:
          if (
            !(usedClamping & ClampDirection.CLAMP_TOP) &&
            !(usedClamping & ClampDirection.CLAMP_BOTTOM)
          ) {
            sideToMove = SideAdjust.SIDE_TOP_BOTTOM_SAME;
          } else {
            sideToMove = SideAdjust.SIDE_RIGHT;
          }
          break;
        case ResizeDirection.RESIZE_SOUTHEAST:
          if (!(usedClamping & ClampDirection.CLAMP_BOTTOM)) {
            sideToMove = SideAdjust.SIDE_BOTTOM;
          } else {
            sideToMove = SideAdjust.SIDE_RIGHT;
          }
          break;
        case ResizeDirection.RESIZE_SOUTHWEST:
          if (!(usedClamping & ClampDirection.CLAMP_BOTTOM)) {
            sideToMove = SideAdjust.SIDE_BOTTOM;
          } else {
            sideToMove = SideAdjust.SIDE_LEFT;
          }
          break;
        case ResizeDirection.RESIZE_WEST:
          if (
            !(usedClamping & ClampDirection.CLAMP_TOP) &&
            !(usedClamping & ClampDirection.CLAMP_BOTTOM)
          ) {
            sideToMove = SideAdjust.SIDE_TOP_BOTTOM_SAME;
          } else {
            sideToMove = SideAdjust.SIDE_LEFT;
          }
          break;
      }
    } else {
      console.log(
        `case 2: frame top = ${frame.Top}, left = ${frame.Left}, right = ${frame.Right}, bottom = ${frame.Bottom}, width = ${frame.Width}, height = ${frame.Height}, centerx = ${frame.CenterX}, centery = ${frame.CenterY}`
      );
      // In this case the height is too much for the aspect ratio. If possible we will increase the width to account for
      // this, but barring that we reduce the height.
      switch (resizeDirection) {
        case ResizeDirection.RESIZE_NORTHWEST:
          if (!(usedClamping & ClampDirection.CLAMP_LEFT)) {
            sideToMove = SideAdjust.SIDE_LEFT;
          } else {
            sideToMove = SideAdjust.SIDE_TOP;
          }
          break;
        case ResizeDirection.RESIZE_NORTH:
          if (
            !(usedClamping & ClampDirection.CLAMP_LEFT) &&
            !(usedClamping & ClampDirection.CLAMP_RIGHT)
          ) {
            sideToMove = SideAdjust.SIDE_LEFT_RIGHT_SAME;
          } else {
            sideToMove = SideAdjust.SIDE_TOP;
          }
          break;
        case ResizeDirection.RESIZE_NORTHEAST:
          if (!(usedClamping & ClampDirection.CLAMP_RIGHT)) {
            sideToMove = SideAdjust.SIDE_RIGHT;
          } else {
            sideToMove = SideAdjust.SIDE_TOP;
          }
          break;
        case ResizeDirection.RESIZE_EAST:
        case ResizeDirection.RESIZE_WEST:
          sideToMove = SideAdjust.SIDE_TOP_BOTTOM_SAME;
          break;
        case ResizeDirection.RESIZE_SOUTHEAST:
          if (!(usedClamping & ClampDirection.CLAMP_RIGHT)) {
            sideToMove = SideAdjust.SIDE_RIGHT;
          } else {
            sideToMove = SideAdjust.SIDE_BOTTOM;
          }
          break;
        case ResizeDirection.RESIZE_SOUTH:
          if (
            !(usedClamping & ClampDirection.CLAMP_LEFT) &&
            !(usedClamping & ClampDirection.CLAMP_RIGHT)
          ) {
            sideToMove = SideAdjust.SIDE_LEFT_RIGHT_SAME;
          } else {
            sideToMove = SideAdjust.SIDE_BOTTOM;
          }
          break;
        case ResizeDirection.RESIZE_SOUTHWEST:
          if (!(usedClamping & ClampDirection.CLAMP_LEFT)) {
            sideToMove = SideAdjust.SIDE_LEFT;
          } else {
            sideToMove = SideAdjust.SIDE_BOTTOM;
          }
          break;
      }
    }

    // Now that we have a direction in mind, resize as needed in that direction.
    switch (sideToMove) {
      case SideAdjust.SIDE_NONE:
        break;
      case SideAdjust.SIDE_TOP:
        frame.Top = frame.Bottom - frame.Width / desiredAspect;
        break;
      case SideAdjust.SIDE_RIGHT:
        frame.Right = frame.Left + frame.Height * desiredAspect;
        break;
      case SideAdjust.SIDE_BOTTOM:
        frame.Bottom = frame.Top + frame.Width / desiredAspect;
        break;
      case SideAdjust.SIDE_LEFT:
        frame.Left = frame.Right - frame.Height * desiredAspect;
        break;
      case SideAdjust.SIDE_TOP_BOTTOM_SAME:
        console.log('clamping: ', usedClamping);
        let newHeight = frame.Width / desiredAspect;
        if (
          usedClamping & ClampDirection.CLAMP_TOP &&
          !(usedClamping & ClampDirection.CLAMP_BOTTOM)
        ) {
          console.log('clamp top');
          frame.Top = 0;
          frame.Bottom = newHeight;
        } else if (
          usedClamping & ClampDirection.CLAMP_BOTTOM &&
          !(usedClamping & ClampDirection.CLAMP_TOP)
        ) {
          frame.Bottom = parent.Height;
          frame.Top = frame.Bottom - newHeight;
        } else {
          frame.Top = frame.CenterY - newHeight / 2;
          frame.Bottom = frame.Top + newHeight;
        }
        break;
      case SideAdjust.SIDE_LEFT_RIGHT_SAME:
        let newWidth = frame.Height * desiredAspect;
        frame.Left = frame.CenterX - newWidth / 2;
        frame.Right = frame.Left + newWidth;
        break;
    }

    frame.Height = frame.Bottom - frame.Top;
    frame.Width = frame.Right - frame.Left;
    frame.CenterX = Math.floor((frame.Left + frame.Right) / 2);
    frame.CenterY = Math.floor((frame.Top + frame.Bottom) / 2);

    console.log(
      `adjusted frame left = ${frame.Left}, frame right = ${frame.Right}, top = ${frame.Top}, bottom = ${frame.Bottom}, height: ${frame.Height}, width: ${frame.Width}`
    );
  }

  // #endregion

  rectangle_recalculate_center_xy(result: Rectangle) {
    result.center_x_on_fixed_center = (result.x1 + result.x2) / 2;
    result.center_y_on_fixed_center = (result.y1 + result.y2) / 2;
  }

  rectangle_handle_general_clamping(result: Rectangle, dragType: string) {
    const constraint = this.rectange_get_constraint(result);

    if (constraint === RECTANGLE_CONSTRAIN_NONE) return;

    if (dragType !== 'move') {
      rectangle_clamp(result, null, constraint, this.fixed_center);
    } else {
      rectangle_keep_inside(result, constraint);
    }
  }

  rectangle_apply_fixed_rule(result: Rectangle, dragType: string) {
    const constraint = rectange_get_constraint(result);

    const aspect = this.Clamp(
      this.aspect_numerator / this.aspect_denominator,
      1.0 / this.parentStart.Height,
      this.parentStart.Width
    ); // In GIMP, this is 1.0 / image_height, image_width

    if (dragType !== 'move') {
      let clamped_sides: ClampedSide = ClampedSide.CLAMPED_NONE;

      rectange_apply_aspect(result, aspect, clamped_sides);

      clamped_sides = rectangle_clamp(
        result,
        clamped_sides,
        constraint,
        this.fixed_center
      );

      rectangle_apply_aspect(result, aspect, clamped_sides);
    } else {
      rectangle_apply_aspect(result, aspect, ClampedSide.CLAMPED_NONE);

      rectangle_keep_inside(result, constraint);
    }
  }

  rectangle_update_with_coord(
    rectangle: Rectangle,
    dragType: string,
    new_x: number,
    new_y: number
  ) {
    this.rectangle_apply_coord(rectangle, new_x, new_y);

    this.rectangle_handle_general_clamping(rectangle);

    if (dragType !== 'move') {
      this.rectangle_apply_fixed_rule(rectangle, dragType);
    }

    this.rectangle_update_int_rect(rectangle);
  }

  rectangle_apply_aspect(
    rectangle: Rectangle,
    aspect: number,
    clamped_sides: number
  ) {
    let current_w: number;
    let current_h: number;
    let current_aspect: number;
    let side_to_resize: SideToResize = SideToResize.SIDE_TO_RESIZE_NONE;

    current_w = rectangle.x2 - rectangle.x1;
    current_h = rectangle.y2 - rectangle.y1;

    current_aspect = current_w / current_h;

    /* Do we have to do anything? */
    if (current_aspect - aspect < 1e-4) return;

    if (current_aspect > aspect) {
      /* We can safely pick LEFT or RIGHT, since using those sides
       * will make the rectangle smaller, so we don't need to check
       * for clamped_sides. We may only use TOP and BOTTOM if not
       * those sides have been clamped, since using them will make the
       * rectangle bigger.
       */
      switch (rectangle.function) {
        case ResizingFunction.RESIZING_UPPER_LEFT:
          if (!(clamped_sides & ClampedSide.CLAMPED_TOP))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
          break;

        case ResizingFunction.RESIZING_UPPER_RIGHT:
          if (!(clamped_sides & ClampedSide.CLAMPED_TOP))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
          break;

        case ResizingFunction.RESIZING_LOWER_LEFT:
          if (!(clamped_sides & ClampedSide.CLAMPED_BOTTOM))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
          break;

        case ResizingFunction.RESIZING_LOWER_RIGHT:
          if (!(clamped_sides & ClampedSide.CLAMPED_BOTTOM))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
          break;

        case ResizingFunction.RESIZING_LEFT:
          if (
            !(clamped_sides & ClampedSide.CLAMPED_TOP) &&
            !(clamped_sides & ClampedSide.CLAMPED_BOTTOM)
          )
            side_to_resize =
              SideToResize.SIDE_TO_RESIZE_TOP_AND_BOTTOM_SYMMETRICALLY;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
          break;

        case ResizingFunction.RESIZING_RIGHT:
          if (
            !(clamped_sides & ClampedSide.CLAMPED_TOP) &&
            !(clamped_sides & ClampedSide.CLAMPED_BOTTOM)
          )
            side_to_resize =
              SideToResize.SIDE_TO_RESIZE_TOP_AND_BOTTOM_SYMMETRICALLY;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
          break;

        case ResizingFunction.RESIZING_BOTTOM:
        case ResizingFunction.RESIZING_TOP:
          side_to_resize =
            SideToResize.SIDE_TO_RESIZE_LEFT_AND_RIGHT_SYMMETRICALLY;
          break;

        case ResizingFunction.MOVING:
        default:
          if (!(clamped_sides & ClampedSide.CLAMPED_BOTTOM))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
          else if (!(clamped_sides & ClampedSide.CLAMPED_RIGHT))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
          else if (!(clamped_sides & ClampedSide.CLAMPED_TOP))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
          else if (!(clamped_sides & ClampedSide.CLAMPED_LEFT))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
          break;
      }
    } /* (current_aspect < aspect) */ else {
      /* We can safely pick TOP or BOTTOM, since using those sides
       * will make the rectangle smaller, so we don't need to check
       * for clamped_sides. We may only use LEFT and RIGHT if not
       * those sides have been clamped, since using them will make the
       * rectangle bigger.
       */
      switch (rectangle.function) {
        case ResizingFunction.RESIZING_UPPER_LEFT:
          if (!(clamped_sides & ClampedSide.CLAMPED_LEFT))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
          break;

        case ResizingFunction.RESIZING_UPPER_RIGHT:
          if (!(clamped_sides & ClampedSide.CLAMPED_RIGHT))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
          break;

        case ResizingFunction.RESIZING_LOWER_LEFT:
          if (!(clamped_sides & ClampedSide.CLAMPED_LEFT))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
          break;

        case ResizingFunction.RESIZING_LOWER_RIGHT:
          if (!(clamped_sides & ClampedSide.CLAMPED_RIGHT))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
          break;

        case ResizingFunction.RESIZING_TOP:
          if (
            !(clamped_sides & ClampedSide.CLAMPED_LEFT) &&
            !(clamped_sides & ClampedSide.CLAMPED_RIGHT)
          )
            side_to_resize =
              SideToResize.SIDE_TO_RESIZE_LEFT_AND_RIGHT_SYMMETRICALLY;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
          break;

        case ResizingFunction.RESIZING_BOTTOM:
          if (
            !(clamped_sides & ClampedSide.CLAMPED_LEFT) &&
            !(clamped_sides & ClampedSide.CLAMPED_RIGHT)
          )
            side_to_resize =
              SideToResize.SIDE_TO_RESIZE_LEFT_AND_RIGHT_SYMMETRICALLY;
          else side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
          break;

        case ResizingFunction.RESIZING_LEFT:
        case ResizingFunction.RESIZING_RIGHT:
          side_to_resize =
            SideToResize.SIDE_TO_RESIZE_TOP_AND_BOTTOM_SYMMETRICALLY;
          break;

        case ResizingFunction.MOVING:
        default:
          if (!(clamped_sides & ClampedSide.CLAMPED_BOTTOM))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_BOTTOM;
          else if (!(clamped_sides & ClampedSide.CLAMPED_RIGHT))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_RIGHT;
          else if (!(clamped_sides & ClampedSide.CLAMPED_TOP))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_TOP;
          else if (!(clamped_sides & ClampedSide.CLAMPED_LEFT))
            side_to_resize = SideToResize.SIDE_TO_RESIZE_LEFT;
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
        rectangle.x1 = rectangle.x2 - aspect * current_h;
        break;

      case SideToResize.SIDE_TO_RESIZE_RIGHT:
        rectangle.x2 = rectangle.x1 + aspect * current_h;
        break;

      case SideToResize.SIDE_TO_RESIZE_TOP:
        rectangle.y1 = rectangle.y2 - current_w / aspect;
        break;

      case SideToResize.SIDE_TO_RESIZE_BOTTOM:
        rectangle.y2 = rectangle.y1 + current_w / aspect;
        break;

      case SideToResize.SIDE_TO_RESIZE_TOP_AND_BOTTOM_SYMMETRICALLY:
        {
          const correct_h = current_w / aspect;

          rectangle.y1 = rectangle.center_y_on_fixed_center - correct_h / 2;
          rectangle.y2 = rectangle.y1 + correct_h;
        }
        break;

      case SideToResize.SIDE_TO_RESIZE_LEFT_AND_RIGHT_SYMMETRICALLY:
        {
          const correct_w = current_h * aspect;

          rectangle.x1 = rectangle.center_x_on_fixed_center - correct_w / 2;
          rectangle.x2 = rectangle.x1 + correct_w;
        }
        break;
    }
  }

  rectangle_keep_inside_vertically(
    rectangle: Rectangle,
    constraint: RectangleConstraint
  ) {
    let min_y;
    let max_y;

    if (constraint == CONSTRAIN_NONE) return;

    const constraints = this.rectangle_get_constraints(
      rectangle,
      null,
      min_y,
      null,
      max_y,
      constraint
    );

    min_y = constraints.min_y;
    max_y = constraints.max_y;

    if (max_y - min_y < rectangle.y2 - rectangle.y1) {
      rectangle.y1 = min_y;
      rectangle.y2 = max_y;
    } else {
      if (rectangle.y1 < min_y) {
        const dy = min_y - rectangle.y1;

        rectangle.y1 += dy;
        rectangle.y2 += dy;
      }
      if (rectangle.y2 > max_y) {
        const dy = max_y - rectangle.y2;

        rectangle.y1 += dy;
        rectangle.y2 += dy;
      }
    }
  }

  rectangle_keep_inside_horizontally(
    rectangle: Rectangle,
    constraint: RectangleConstraint
  ) {
    let min_x;
    let max_x;

    if (constraint == CONSTRAIN_NONE) return;

    const constraints = this.rectangle_get_constraints(
      rectangle,
      min_x,
      null,
      max_x,
      null,
      constraint
    );

    min_x = constraints.min_x;
    max_x = constraints.max_x;

    if (max_x - min_x < rectangle.x2 - rectangle.x1) {
      rectangle.x1 = min_x;
      rectangle.x2 = max_x;
    } else {
      if (rectangle.x1 < min_x) {
        const dx = min_x - rectangle.x1;

        rectangle.x1 += dx;
        rectangle.x2 += dx;
      }
      if (rectangle.x2 > max_x) {
        const dx = max_x - rectangle.x2;

        rectangle.x1 += dx;
        rectangle.x2 += dx;
      }
    }
  }

  rectangle_keep_inside(rectangle: Rectangle, constraint: RectangleConstraint) {
    this.rectangle_keep_inside_horizontally(rectangle, constraint);
    this.rectangle_keep_inside_vertically(rectangle, constraint);
  }

  rectangle_clamp_height(
    rectangle: Rectangle,
    clamped_sides: ClampedSide,
    constraint: RectangleConstraint,
    symmetrically: boolean
  ) {
    let min_y;
    let max_y;

    if (constraint == CONSTRAIN_NONE) return;

    const constraints = this.rectangle_get_constraints(
      rectangle,
      null,
      min_y,
      null,
      max_y,
      constraint
    );

    min_y = constraints.min_y;
    max_y = constraints.max_y;

    if (rectangle.y1 < min_y) {
      const dy = min_y - rectangle.y1;

      rectangle.y1 += dy;

      if (symmetrically) rectangle.y2 -= dy;

      if (rectangle.y2 < min_y) rectangle.y2 = min_y;

      if (clamped_sides) clamped_sides |= ClampedSide.CLAMPED_TOP;
    }

    if (rectangle.y2 > max_y) {
      const dy = max_y - rectangle.y2;

      rectangle.y2 += dy;

      if (symmetrically) rectangle.y1 -= dy;

      if (rectangle.y1 > max_y) rectangle.y1 = max_y;

      if (clamped_sides) clamped_sides |= ClampedSide.CLAMPED_BOTTOM;
    }

    return clamped_sides;
  }

  rectangle_clamp_width(
    rectangle: Rectangle,
    clamped_sides: ClampedSide,
    constraint: RectangleConstraint,
    symmetrically: boolean
  ) {
    let min_x;
    let max_x;

    if (constraint == CONSTRAIN_NONE) return;

    const constraints = this.rectangle_get_constraints(
      rectangle,
      min_x,
      null,
      max_x,
      null,
      constraint
    );

    min_x = constraints.min_x;
    max_x = constraints.max_x;

    if (rectangle.x1 < min_x) {
      const dx = min_x - rectangle.x1;

      rectangle.x1 += dx;

      if (symmetrically) rectangle.x2 -= dx;

      if (rectangle.x2 < min_x) rectangle.x2 = min_x;

      if (clamped_sides) clamped_sides |= ClampedSide.CLAMPED_LEFT;
    }

    if (rectangle.x2 > max_x) {
      const dx = max_x - rectangle.x2;

      rectangle.x2 += dx;

      if (symmetrically) rectangle.x1 -= dx;

      if (rectangle.x1 > max_x) rectangle.x1 = max_x;

      if (clamped_sides) clamped_sides |= ClampedSide.CLAMPED_RIGHT;
    }

    return clamped_sides;
  }

  rectangle_clamp(
    rectangle: Rectangle,
    clamped_sides: ClampedSide,
    constraint: RectangleConstraint,
    symmetrically: boolean
  ) {
    clamped_sides = this.rectangle_clamp_width(
      rectangle,
      clamped_sides,
      constraint,
      symmetrically
    );

    clamped_sides = this.rectangle_clamp_height(
      rectangle,
      clamped_sides,
      constraint,
      symmetrically
    );

    return clamped_sides;
  }

  rectangle_apply_coord (rectangle: Rectangle,
                                 coord_x: number,
                                 coord_y: number)
{
  if (rectangle.function == ResizingFunction.MOVING)
    {
      /* Preserve width and height while moving the grab-point to where the
       * cursor is.
       */
      const w = rectangle.x2 - rectangle.x1;
      const h = rectangle.y2 - rectangle.y1;

      rectangle.x1 = coord_x;
      rectangle.y1 = coord_y;

      rectangle.x2 = rectangle.x1 + w;
      rectangle.y2 = rectangle.y1 + h;

      /* We are done already. */
      return;
    }

  switch (rectangle.function)
    {
    case ResizingFunction.RESIZING_UPPER_LEFT:
    case ResizingFunction.RESIZING_LOWER_LEFT:
    case ResizingFunction.RESIZING_LEFT:
      rectangle.x1 = coord_x;

      if (rectangle.fixed_center)
        rectangle.x2 = 2 * rectangle.center_x_on_fixed_center - rectangle.x1;

      break;

    case ResizingFunction.RESIZING_UPPER_RIGHT:
    case ResizingFunction.RESIZING_LOWER_RIGHT:
    case ResizingFunction.RESIZING_RIGHT:
      rectangle.x2 = coord_x;

      if (rectangle.fixed_center)
        rectangle.x1 = 2 * rectangle.center_x_on_fixed_center - rectangle.x2;

      break;

    default:
      break;
    }

  switch (rectangle.function)
    {
    case ResizingFunction.RESIZING_UPPER_LEFT:
    case ResizingFunction.RESIZING_UPPER_RIGHT:
    case ResizingFunction.RESIZING_TOP:
      rectangle.y1 = coord_y;

      if (rectangle.fixed_center)
        rectangle.y2 = 2 * rectangle.center_y_on_fixed_center - rectangle.y1;

      break;

    case ResizingFunction.RESIZING_LOWER_LEFT:
    case ResizingFunction.RESIZING_LOWER_RIGHT:
    case ResizingFunction.RESIZING_BOTTOM:
      rectangle.y2 = coord_y;

      if (rectangle.fixed_center)
        rectangle.y1 = 2 * rectangle.center_y_on_fixed_center - rectangle.y2;

      break;

    default:
      break;
    }
}

}

interface CursorPosition {
  x: number;
  y: number;
}

interface Rectangle {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  center_x_on_fixed_center: number;
  center_y_on_fixed_center: number;
  function: ResizingFunction;
  fixed_center: boolean;
}

interface FramePosition {
  Top: number;
  Left: number;
  Right: number;
  Bottom: number;
  CenterX: number;
  CenterY: number;
  Width: number;
  Height: number;
}

interface FrameProblem {
  DX: number;
  DY: number;
  OrigTop: number;
  OrigLeft: number;
  OrigHeight: number;
  OrigWidth: number;
  ParentWidth: number;
  ParentHeight: number;
  AspectX: number;
  AspectY: number;
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
