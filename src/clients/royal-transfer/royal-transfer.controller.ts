import { Body, Controller, Get, Param, Patch, Post, Request, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiExcludeEndpoint } from '@nestjs/swagger';

import { RoyalTransferClient } from './royal-transfer.client';
import { RoyalTransferService } from './royal-transfer.service';
import { RoyalTransferPobBooking } from './royal-transfer.types';
import { FlexibleAuthGuard } from '../../guards/flexible-auth.guard';

/** Request shape when FlexibleAuthGuard has attached user (companyId optional). */
interface RequestWithUser {
  user?: { companyId?: string };
}

@ApiTags('Integrations — Royal Transfer')
@Controller('integrations/royal-transfer')
export class RoyalTransferController {
  constructor(
    private readonly royalTransfer: RoyalTransferClient,
    private readonly royalTransferService: RoyalTransferService,
  ) {}

  @Get('bookings')
  @ApiOperation({
    summary: "Test: fetch today's POB bookings",
    description:
      "Calls the Royal Transfer API GET /public/bookings and returns today's POB bookings (for testing the integration).",
  })
  @ApiResponse({
    status: 200,
    description:
      'Bookings fetched successfully (or empty array if API unreachable, 401, or no data). Server does not crash when Royal Transfer is down.',
  })
  async getBookings(): Promise<{
    ok: boolean;
    count: number;
    bookings: RoyalTransferPobBooking[];
  }> {
    const bookings = await this.royalTransfer.getTodayPobBookings();
    return {
      ok: true,
      count: bookings.length,
      bookings,
    };
  }

  @Post('trigger-driver-reminders')
  @UseGuards(FlexibleAuthGuard)
  async triggerDriverReminders(@Request() req: RequestWithUser): Promise<{
    ok: boolean;
    triggered: number;
    failed: { bookingId: string; driverNumber: string; error: string }[];
    callSids: string[];
  }> {
    const companyId = req.user?.companyId;
    return this.royalTransferService.triggerDriverReminders(companyId);
  }

  @Get('driver-reminder/template')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Get driver reminder script templates',
    description:
      'Returns the stored templates for driver reminder calls. POB (and non-cancelled) asks driver to confirm they are coming; CANCELLED only informs driver. Placeholders: {{driverName}}, {{pickup}}, {{dropOff}}, {{time}}, {{date}}, {{status}}.',
  })
  @ApiResponse({ status: 200, description: 'Templates and placeholders' })
  getDriverReminderTemplate(): {
    template: string;
    templateCancelled: string;
    placeholders: readonly string[];
  } {
    return {
      template: this.royalTransferService.getDriverReminderTemplate(),
      templateCancelled: this.royalTransferService.getDriverReminderTemplateCancelled(),
      placeholders: this.royalTransferService.getDriverReminderPlaceholders(),
    };
  }

  @Post('driver-reminder/preview')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Preview driver reminder script for a booking',
    description:
      'Renders the driver reminder script for the given booking (e.g. to preview before calling).',
  })
  @ApiBody({
    description: 'Booking object (e.g. from GET /integrations/royal-transfer/bookings)',
    schema: {
      type: 'object',
      required: ['booking'],
      properties: {
        booking: {
          type: 'object',
          properties: {
            bookingId: { type: 'string' },
            rt: { type: 'number' },
            pickup: { type: 'string' },
            dropOff: { type: 'string' },
            status: { type: 'string' },
            time: { type: 'string' },
            date: { type: 'string' },
            driverName: { type: 'string' },
            driverNumber: { type: 'string' },
          },
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: 'Rendered script and normalized driver number' })
  previewDriverReminder(@Body() body: { booking: RoyalTransferPobBooking }): {
    script: string;
    booking: RoyalTransferPobBooking;
    normalizedDriverNumber: string;
  } {
    const script = this.royalTransferService.renderDriverReminderForBooking(body.booking);
    const normalizedDriverNumber = this.royalTransferService.getNormalizedDriverNumber(
      body.booking,
    );
    return { script, booking: body.booking, normalizedDriverNumber };
  }

  @Get('driver-reminder/bookings-with-scripts')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: "Today's bookings with rendered driver reminder scripts",
    description:
      "Fetches today's POB bookings and returns each with the script text and E.164-normalized driver number for outbound calls.",
  })
  @ApiResponse({ status: 200, description: 'Bookings with scripts and normalizedDriverNumber' })
  @ApiResponse({ status: 500, description: 'Royal Transfer API error' })
  async getBookingsWithScripts(): Promise<{
    ok: boolean;
    count: number;
    data: {
      booking: RoyalTransferPobBooking;
      script: string;
      normalizedDriverNumber: string;
    }[];
  }> {
    const data = await this.royalTransferService.getTodayBookingsWithScripts();
    return {
      ok: true,
      count: data.length,
      data,
    };
  }

  @Patch('bookings/:bookingId/cancel-by-driver')
  @UseGuards(FlexibleAuthGuard)
  @ApiOperation({
    summary: 'Cancel booking by driver (from call)',
    description:
      'Sets the booking to CANCELLED on the Royal Transfer platform when the driver cancels during/from a call. Uses PATCH /public/bookings/:id/cancel-by-driver.',
  })
  @ApiResponse({ status: 200, description: 'Booking cancelled by driver' })
  @ApiResponse({ status: 404, description: 'Booking not found' })
  async cancelBookingByDriver(
    @Param('bookingId') bookingId: string,
    @Body() body: { reason?: string },
  ): Promise<{ ok: boolean; cancelled: boolean }> {
    const cancelled = await this.royalTransferService.cancelBookingByDriver(
      bookingId,
      body?.reason ?? undefined,
    );
    return { ok: true, cancelled };
  }

  @Get('driver-reminder/preview/:bookingId')
  @ApiExcludeEndpoint()
  @ApiOperation({
    summary: 'Preview script for a booking by ID',
    description:
      "Fetches today's bookings, finds the one with the given bookingId, and returns the rendered driver reminder script and normalized driver number.",
  })
  @ApiResponse({ status: 200, description: 'Rendered script and normalizedDriverNumber' })
  @ApiResponse({ status: 404, description: "Booking not found in today's list" })
  async previewDriverReminderByBookingId(
    @Param('bookingId') bookingId: string,
  ): Promise<
    | { script: string; booking: RoyalTransferPobBooking; normalizedDriverNumber: string }
    | { error: string }
  > {
    return this.royalTransferService.getPreviewByBookingId(bookingId);
  }
}
