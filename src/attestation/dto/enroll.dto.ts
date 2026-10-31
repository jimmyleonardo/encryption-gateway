import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
} from 'class-validator';

export class EnrollDeviceDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  challengeId!: string;

  @IsNotEmpty()
  @IsString()
  @MaxLength(128)
  deviceId!: string;

  @IsArray()
  @ArrayMinSize(2)
  // A Keystore chain is leaf + intermediates + root; well beyond this is abuse.
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(8192, { each: true })
  certificateChain!: string[];
}
