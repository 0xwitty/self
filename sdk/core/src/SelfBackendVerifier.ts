import { registryAbi } from './abi/IdentityRegistryImplV1';
import { verifyAllAbi } from './abi/VerifyAll';
import {
  REGISTRY_ADDRESS,
  VERIFYALL_ADDRESS,
  REGISTRY_ADDRESS_STAGING,
  VERIFYALL_ADDRESS_STAGING,
} from './constants/contractAddresses';
import { ethers } from 'ethers';
import { PublicSignals } from 'snarkjs';
import type { SelfVerificationResult } from '../../../common/src/utils/selfAttestation';
import {
  castToScope,
  castToUserIdentifier,
  UserIdType,
} from '../../../common/src/utils/circuits/uuid';
import { CIRCUIT_CONSTANTS, revealedDataTypes } from '../../../common/src/constants/constants';
import { packForbiddenCountriesList } from '../../../common/src/utils/contracts/formatCallData';
import { Country3LetterCode, commonNames } from '../../../common/src/constants/countries';
import { hashEndpointWithScope } from '../../../common/src/utils/scope';

const CELO_MAINNET_RPC_URL = "https://forno.celo.org";
const CELO_TESTNET_RPC_URL = "https://alfajores-forno.celo-testnet.org";

export class SelfBackendVerifier {
  protected scope: string;
  protected attestationId: number = 1;
  protected user_identifier_type: UserIdType = 'uuid';
  protected targetRootTimestamp: { enabled: boolean; value: number } = {
    enabled: false,
    value: 0,
  };

  protected nationality: {
    enabled: boolean;
    value: Country3LetterCode;
  } = {
      enabled: false,
      value: '' as Country3LetterCode,
    };
  protected minimumAge: { enabled: boolean; value: string } = {
    enabled: false,
    value: '18',
  };
  protected excludedCountries: {
    enabled: boolean;
    value: Country3LetterCode[];
  } = {
      enabled: false,
      value: [],
    };
  protected passportNoOfac: boolean = false;
  protected nameAndDobOfac: boolean = false;
  protected nameAndYobOfac: boolean = false;

  protected registryContract: ethers.Contract;
  protected verifyAllContract: ethers.Contract;
  protected mockPassport: boolean;

  constructor(
    scope: string,
    endpoint: string,
    user_identifier_type: UserIdType = 'uuid',
    mockPassport: boolean = false
  ) {
    const rpcUrl = mockPassport ? CELO_TESTNET_RPC_URL : CELO_MAINNET_RPC_URL;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const registryAddress = mockPassport ? REGISTRY_ADDRESS_STAGING : REGISTRY_ADDRESS;
    const verifyAllAddress = mockPassport ? VERIFYALL_ADDRESS_STAGING : VERIFYALL_ADDRESS;
    this.registryContract = new ethers.Contract(registryAddress, registryAbi, provider);
    this.verifyAllContract = new ethers.Contract(verifyAllAddress, verifyAllAbi, provider);
    this.scope = hashEndpointWithScope(endpoint, scope);
    this.user_identifier_type = user_identifier_type;
    this.mockPassport = mockPassport;
  }

  public async verify(proof: any, publicSignals: PublicSignals): Promise<SelfVerificationResult> {
    const forbiddenCountriesListPacked = packForbiddenCountriesList(this.excludedCountries.value);

    const isValidScope =
      this.scope === publicSignals[CIRCUIT_CONSTANTS.VC_AND_DISCLOSE_SCOPE_INDEX];

    const isValidAttestationId =
      this.attestationId.toString() ===
      publicSignals[CIRCUIT_CONSTANTS.VC_AND_DISCLOSE_ATTESTATION_ID_INDEX];

    const vcAndDiscloseHubProof = {
      olderThanEnabled: this.minimumAge.enabled,
      olderThan: this.minimumAge.value,
      forbiddenCountriesEnabled: this.excludedCountries.enabled,
      forbiddenCountriesListPacked: forbiddenCountriesListPacked,
      ofacEnabled: [this.passportNoOfac, this.nameAndDobOfac, this.nameAndYobOfac],
      vcAndDiscloseProof: {
        a: proof.a,
        b: [
          [proof.b[0][1], proof.b[0][0]],
          [proof.b[1][1], proof.b[1][0]],
        ],
        c: proof.c,
        pubSignals: publicSignals,
      },
    };

    const types = [
      revealedDataTypes.issuing_state,
      revealedDataTypes.name,
      revealedDataTypes.passport_number,
      revealedDataTypes.nationality,
      revealedDataTypes.date_of_birth,
      revealedDataTypes.gender,
      revealedDataTypes.expiry_date,
    ];

    if (this.minimumAge.enabled) {
      types.push(revealedDataTypes.older_than);
    }

    if (this.passportNoOfac) {
      types.push(revealedDataTypes.passport_no_ofac);
    }

    if (this.nameAndDobOfac) {
      types.push(revealedDataTypes.name_and_dob_ofac);
    }

    if (this.nameAndYobOfac) {
      types.push(revealedDataTypes.name_and_yob_ofac);
    }

    const currentRoot = await this.registryContract.getIdentityCommitmentMerkleRoot();
    const timestamp = await this.registryContract.rootTimestamps(currentRoot);

    const user_identifier = castToUserIdentifier(
      BigInt(publicSignals[CIRCUIT_CONSTANTS.VC_AND_DISCLOSE_USER_IDENTIFIER_INDEX]),
      this.user_identifier_type
    );

    let result: any;
    try {
      result = await this.verifyAllContract.verifyAll(timestamp, vcAndDiscloseHubProof, types);
    } catch (error) {
      return {
        isValid: false,
        isValidDetails: {
          isValidScope: false,
          isValidAttestationId: false,
          isValidProof: false,
          isValidNationality: false,
        },
        userId: user_identifier,
        application: this.scope,
        nullifier: publicSignals[CIRCUIT_CONSTANTS.VC_AND_DISCLOSE_NULLIFIER_INDEX],
        credentialSubject: {},
        proof: {
          value: {
            proof: proof,
            publicSignals: publicSignals,
          },
        },
        error: error,
      };
    }

    let isValidNationality = true;
    if (this.nationality.enabled) {
      const nationality = result[0][revealedDataTypes.nationality];
      isValidNationality = nationality === this.nationality.value;
    }

    const credentialSubject = {
      merkle_root: publicSignals[CIRCUIT_CONSTANTS.VC_AND_DISCLOSE_MERKLE_ROOT_INDEX],
      attestation_id: this.attestationId.toString(),
      current_date: new Date().toISOString(),
      issuing_state: result[0][revealedDataTypes.issuing_state],
      name: result[0][revealedDataTypes.name],
      passport_number: result[0][revealedDataTypes.passport_number],
      nationality: result[0][revealedDataTypes.nationality],
      date_of_birth: result[0][revealedDataTypes.date_of_birth],
      gender: result[0][revealedDataTypes.gender],
      expiry_date: result[0][revealedDataTypes.expiry_date],
      older_than: result[0][revealedDataTypes.older_than].toString(),
      passport_no_ofac: result[0][revealedDataTypes.passport_no_ofac].toString() === '1',
      name_and_dob_ofac: result[0][revealedDataTypes.name_and_dob_ofac].toString() === '1',
      name_and_yob_ofac: result[0][revealedDataTypes.name_and_yob_ofac].toString() === '1',
    };

    const attestation: SelfVerificationResult = {
      isValid: result[1] && isValidScope && isValidAttestationId && isValidNationality,
      isValidDetails: {
        isValidScope: isValidScope,
        isValidAttestationId: isValidAttestationId,
        isValidProof: result[1],
        isValidNationality: isValidNationality,
      },
      userId: user_identifier,
      application: this.scope,
      nullifier: publicSignals[CIRCUIT_CONSTANTS.VC_AND_DISCLOSE_NULLIFIER_INDEX],
      credentialSubject: credentialSubject,
      proof: {
        value: {
          proof: proof,
          publicSignals: publicSignals,
        },
      },
      error: result[2],
    };

    return attestation;
  }

  setMinimumAge(age: number): this {
    if (age <= 0) {
      throw new Error('Minimum age must be positive');
    }
    if (age > 100) {
      throw new Error('Minimum age must be at most 100 years old');
    }
    this.minimumAge = { enabled: true, value: age.toString() };
    return this;
  }

  setNationality(country: Country3LetterCode): this {
    this.nationality = { enabled: true, value: country };
    return this;
  }

  excludeCountries(...countries: Country3LetterCode[]): this {
    if (countries.length > 40) {
      throw new Error('Number of excluded countries cannot exceed 40');
    }
    this.excludedCountries = { enabled: true, value: countries };
    return this;
  }

  enablePassportNoOfacCheck(): this {
    this.passportNoOfac = true;
    return this;
  }

  enableNameAndDobOfacCheck(): this {
    this.nameAndDobOfac = true;
    return this;
  }

  enableNameAndYobOfacCheck(): this {
    this.nameAndYobOfac = true;
    return this;
  }
}
