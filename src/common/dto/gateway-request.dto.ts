import { IsBase64, IsOptional, IsString, Length } from 'class-validator';

/**
 * Gateway request body (Hybrid RSA-OAEP + AES-256-GCM):
 *   1. Generates a random AES-256 key and a 12-byte IV.
 *   2. Encrypts JSON payload with AES-256-GCM -> `Payload` (ciphertext + 16-byte tag).
 *   3. Encrypts the raw AES key with RSA-OAEP-SHA256 -> `EncryptedKey`.
 */
export class GatewayRequestDto {
  /** Which gateway key was used (from GET /public-key). Default: primary. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  KeyId?: string;

  @IsBase64()
  EncryptedKey!: string;

  @IsBase64()
  IV!: string;

  @IsBase64()
  Payload!: string;
}

// Backward-compatibility alias
export { GatewayRequestDto as GatewayV2RequestDto };
