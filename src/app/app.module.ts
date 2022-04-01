import { NgModule } from '@angular/core';
import { BrowserModule } from '@angular/platform-browser';

import { AppRoutingModule } from './app-routing.module';
import { AppComponent } from './app.component';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';

import { MatIconModule } from '@angular/material/icon';

import { DragDirective, DragHandleDirective } from './drag.directive';

@NgModule({
  declarations: [AppComponent, DragDirective, DragHandleDirective],
  imports: [
    BrowserModule,
    AppRoutingModule,
    BrowserAnimationsModule,
    MatIconModule,
  ],
  providers: [DragDirective, DragHandleDirective],
  bootstrap: [AppComponent],
})
export class AppModule {}
