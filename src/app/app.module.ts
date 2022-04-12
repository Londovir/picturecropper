import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';

import { MatIconModule } from '@angular/material/icon';

import { DragDirective, DragFrameDirective, DragHandleDirective, DragShadowDirective } from './drag.directive';

@NgModule({
    declarations: [AppComponent, DragDirective, DragHandleDirective, DragShadowDirective, DragFrameDirective],
    imports: [BrowserModule, AppRoutingModule, BrowserAnimationsModule, MatIconModule],
    providers: [DragDirective, DragHandleDirective, DragShadowDirective, DragFrameDirective],
    bootstrap: [AppComponent],
})
export class AppModule {}
