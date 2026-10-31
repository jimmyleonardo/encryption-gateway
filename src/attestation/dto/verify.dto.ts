import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyDeviceDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  challengeId!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  deviceId!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(1024)
  signature!: string;
}
