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
  private frameRect: DOMRect;
  private containerRect: DOMRect;
  private dragZone: Rectangle = { x1: 0, y1: 0, x2: 0, y2: 0 };
  private frameStart: FramePosition = {
    Left: 0,
    Top: 0,
    Right: 0,
    Bottom: 0,
    Width: 0,
    Height: 0,
  };
  private parentStart: FramePosition = {
    Left: 0,
    Top: 0,
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
      Right: this.frameEle.offsetTop + this.frameEle.offsetWidth - 1,
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
          newWidth = origWidth + spaceX + 1;
          newHeight = Math.floor((newWidth * self.aspectY) / self.aspectX);
          spaceY = Math.floor((spaceX * self.aspectY) / self.aspectX);
          stepsY = Math.floor(spaceY / 2);
          newTop = Math.max(origTop - stepsY, 0);
          if (newTop + newHeight > maxY) {
            stepsY = newTop + newHeight - maxY - 1;
            newTop -= stepsY;
          }
        } else {
          // The N/S axis runs out first. Max the expansion to both walls, then move the E axis the same amount.
          newHeight = origHeight + spaceY + 1;
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
          stepsY = newTop + newHeight - maxY - 1;
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
          self.cursorStart = {
            x: d.Event?.clientX ?? 0,
            y: d.Event?.clientY ?? 0,
          };
          self.frameStart = {
            Left: self.frameEle.offsetLeft,
            Top: self.frameEle.offsetTop,
            Right: self.frameStart.Left + self.frameEle.offsetWidth - 1,
            Bottom: self.frameStart.Top + self.frameEle.offsetHeight - 1,
            Width: self.frameEle.offsetWidth,
            Height: self.frameEle.offsetHeight,
          };

          // Set parent info.
          const parInfo = self.containerEle.getBoundingClientRect();
          self.parentStart = {
            Top: parInfo.top,
            Left: parInfo.left,
            Right: parInfo.right,
            Bottom: parInfo.bottom,
            Width: self.containerEle.clientWidth,
            Height: self.containerEle.clientHeight,
          };

          // Set drag zone
          const frameCx = self.frameStart.Width / 2;
          const frameCy = self.frameStart.Height / 2;
          self.dragZone = {
            x1: self.parentStart.Left + frameCx - 1,
            y1: self.parentStart.Top + frameCy - 1,
            x2: self.parentStart.Right - frameCx + 1,
            y2: self.parentStart.Bottom - frameCy + 1,
          };
        }),
        // Use switchMap to change over from working with mousedown observables to working with mousemove observables, so we
        // can track the progress of the mouse cursor as we're engaged in this drag/resize.
        switchMap(() =>
          $mousemove!.pipe(
            tap((event) => {
              self.HandleDragMove2(event);
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
      Bottom: self.frameStart.Top + self.frameStart.Height - 1,
      Right: self.frameStart.Left + self.frameStart.Width - 1,
      Height: self.frameStart.Height,
      Width: self.frameStart.Width,
    };

    // Depending on the active handle's purpose, we either move the drag item, or we resize the drag frame in a certain
    // direction.
    if (dragType === 'move') {
      // This is a simple move/drag operation. We apply the (dx,dy) offset to the frame's original position to move it, but
      // we must be mindful of staying within the containing parent's space.
      result.Top += dy;
      result.Left += dx;
      result.Bottom += dy;
      result.Right += dx;

      // Constrain frame to be inside of the parent container.
      self.KeepFrameInsideParent(result, this.parentStart);
    } else {
      // This is a resize event. Based on which handle has been dragged, we must expand the drag frame size as we move the handle,
      // keeping a min and max size constraint in play (based on the drag directive's min size and parent container size). Also,
      // if an aspect ratio has been imposed, we must pin the drag frame to this aspect ratio as we expand.
      switch (dragType) {
        case 'resize-ne':
          if (dx === 0 && dy === 0) break;

          // result = self.CalculateFrameBoxForCornerHandles({
          //   DX: dx,
          //   DY: dy,
          //   OrigHeight: origHeight,
          //   OrigLeft: origLeft,
          //   OrigTop: origTop,
          //   OrigWidth: origWidth,
          //   ParentHeight: self.containerEle.clientHeight,
          //   ParentWidth: self.containerEle.clientWidth,
          //   AspectX: self.aspectX,
          //   AspectY: self.aspectY,
          // });

          break;
        case 'resize-se':
          // Southeast expansion requires rotating by 90 degrees counter-clockwise, then rotating back.
          if (dx === 0 && dy === 0) break;

          // result = self.CalculateFrameBoxForCornerHandles({
          //   DX: dy, // Downward motion changes to rightward motion
          //   DY: dx,
          //   OrigHeight: origWidth,
          //   OrigLeft: origTop,
          //   OrigTop: self.containerEle.clientWidth - origLeft - origWidth,
          //   OrigWidth: origHeight,
          //   ParentHeight: self.containerEle.clientWidth,
          //   ParentWidth: self.containerEle.clientHeight,
          //   AspectX: self.aspectY,
          //   AspectY: self.aspectX,
          // });

          // // The returned result must be rotated back 90 degrees counter-clockwise.
          // [result.Left, result.Top] = [
          //   self.containerEle.clientWidth - result.Top - result.Height,
          //   result.Left,
          // ];
          // [result.Width, result.Height] = [result.Height, result.Width];
          break;
        case 'resize-sw':
          // Southwest expansion requires mirroring across both axes, then mirroring back.
          if (dx === 0 && dy === 0) break;

          // result = self.CalculateFrameBoxForCornerHandles({
          //   DX: -dx, // Leftward motion changes to rightward motion
          //   DY: -dy, // Rightward motion changes to upward motion
          //   OrigHeight: origHeight,
          //   OrigLeft: self.containerEle.clientWidth - origWidth - origLeft + 1,
          //   OrigTop: self.containerEle.clientHeight - origHeight - origTop + 1,
          //   OrigWidth: origWidth,
          //   ParentHeight: self.containerEle.clientHeight,
          //   ParentWidth: self.containerEle.clientWidth,
          //   AspectX: self.aspectX,
          //   AspectY: self.aspectY,
          // });

          // // The returned result must be mirrored back.
          // [result.Left, result.Top] = [
          //   self.containerEle.clientWidth - result.Width - result.Left,
          //   self.containerEle.clientHeight - result.Height - result.Top,
          // ];
          break;
        case 'resize-nw':
          // Northwest expansion requires rotating by 90 degrees clockwise, then rotating back.
          if (dx === 0 && dy === 0) break;

          // result = self.CalculateFrameBoxForCornerHandles({
          //   DX: -dy, // Upward motion changes to rightward motion
          //   DY: dx,
          //   OrigHeight: origWidth,
          //   OrigWidth: origHeight,
          //   OrigLeft: self.containerEle.clientHeight - origTop - origHeight,
          //   OrigTop: origLeft,
          //   ParentHeight: self.containerEle.clientWidth,
          //   ParentWidth: self.containerEle.clientHeight,
          //   AspectX: self.aspectY,
          //   AspectY: self.aspectX,
          // });

          // // The returned result must be rotated back 90 degrees counter-clockwise.
          // [result.Left, result.Top] = [
          //   result.Top,
          //   self.containerEle.clientHeight - result.Left - result.Width,
          // ];
          // [result.Width, result.Height] = [result.Height, result.Width];
          break;
        case 'resize-e':
          // If there is no adjustment in either direction, break immediately.
          if (dx === 0 && dy === 0) break;

          // result = self.CalculateFrameBoxForCenterHandles({
          //   DX: dx,
          //   DY: dy,
          //   OrigHeight: origHeight,
          //   OrigLeft: origLeft,
          //   OrigTop: origTop,
          //   OrigWidth: origWidth,
          //   ParentHeight: self.containerEle.clientHeight,
          //   ParentWidth: self.containerEle.clientWidth,
          //   AspectX: self.aspectX,
          //   AspectY: self.aspectY,
          // });

          break;
        case 'resize-w':
          // Reflect the problem E/W, use the solver, then reflect solution back out.
          if (dx === 0 && dy === 0) break;

          // result = self.CalculateFrameBoxForCenterHandles({
          //   DX: -dx,
          //   DY: dy,
          //   OrigHeight: origHeight,
          //   OrigLeft: self.containerEle.clientWidth - origLeft - origWidth,
          //   OrigTop: origTop,
          //   OrigWidth: origWidth,
          //   ParentHeight: self.containerEle.clientHeight,
          //   ParentWidth: self.containerEle.clientWidth,
          //   AspectX: self.aspectX,
          //   AspectY: self.aspectY,
          // });

          // // The returned Left value now represents the new right edge of the frame, so we must calculate the proper left edge to place in the result.
          // result.Left =
          //   self.containerEle.clientWidth - result.Left - result.Width;

          break;
        case 'resize-n':
          // Rotate the problem 90 deg clockwise, then rotate solution back to the left.
          if (dx === 0 && dy === 0) break;

          // result = self.CalculateFrameBoxForCenterHandles({
          //   DX: -dy, // Upward motion changes to rightward motion
          //   DY: dx,
          //   OrigHeight: origWidth,
          //   OrigLeft: self.containerEle.clientHeight - origTop - origHeight,
          //   OrigTop: origLeft,
          //   OrigWidth: origHeight,
          //   ParentHeight: self.containerEle.clientWidth,
          //   ParentWidth: self.containerEle.clientHeight,
          //   AspectX: self.aspectY,
          //   AspectY: self.aspectX,
          // });

          // // The returned result must be rotated back 90 degrees counter-clockwise.
          // [result.Left, result.Top] = [
          //   result.Top,
          //   self.containerEle.clientHeight - result.Left - result.Width,
          // ];
          // [result.Width, result.Height] = [result.Height, result.Width];
          break;
        case 'resize-s':
          // Rotate the problem 90 deg counter-clockwise, then rotate solution back to the right.
          if (dx === 0 && dy === 0) break;

          // result = self.CalculateFrameBoxForCenterHandles({
          //   DX: dy, // Downward motion changes to rightward motion
          //   DY: dx,
          //   OrigHeight: origWidth,
          //   OrigLeft: origTop,
          //   OrigTop: self.containerEle.clientWidth - origLeft - origWidth,
          //   OrigWidth: origHeight,
          //   ParentHeight: self.containerEle.clientWidth,
          //   ParentWidth: self.containerEle.clientHeight,
          //   AspectX: self.aspectY,
          //   AspectY: self.aspectX,
          // });

          // // The returned result must be rotated back 90 degrees counter-clockwise.
          // [result.Left, result.Top] = [
          //   self.containerEle.clientWidth - result.Top - result.Height,
          //   result.Left,
          // ];
          // [result.Width, result.Height] = [result.Height, result.Width];
          break;
      }
    }

    // Move and resize the drag frame accordingly.
    self.frameEle.style.top = `${result.Top}px`;
    self.frameEle.style.left = `${result.Left}px`;
    self.frameEle.style.width = `${result.Width}px`;
    self.frameEle.style.height = `${result.Height}px`;

    // Update our tracking variables.
    self.frameStart = {
      Top: result.Top,
      Left: result.Left,
      Right: result.Right,
      Bottom: result.Bottom,
      Width: result.Width,
      Height: result.Height,
    };

    // If the cursor position is outside of the drag zone, clamp it accordingly.
    self.cursorStart = {
      x: self.Clamp(event.clientX, this.dragZone.x1, this.dragZone.x2),
      y: self.Clamp(event.clientY, this.dragZone.y1, this.dragZone.y2),
    };
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
        const dx = parent.Width - 1 - frame.Right;
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
        const dy = parent.Height - 1 - frame.Bottom;
        frame.Top += dy;
        frame.Bottom += dy;
      }
    }
  }

  // #endregion
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
}

interface FramePosition {
  Top: number;
  Left: number;
  Right: number;
  Bottom: number;
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
