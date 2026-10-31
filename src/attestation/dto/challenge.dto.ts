import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ChallengeRequestDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  // Purposes are short identifiers chosen by the app (e.g. "enroll", "transfer").
  // Constrained so they cannot be used to store arbitrary attacker data.
  @Matches(/^[a-zA-Z0-9._:-]+$/, {
    message: 'purpose may contain only letters, digits and . _ : -',
  })
  purpose?: string;
}
