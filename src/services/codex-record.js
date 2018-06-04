import ethUtil from 'ethereumjs-util'
import { contracts } from '@codex-protocol/ethereum-service'

import logger from './logger'
import models from '../models'

const zeroAddress = ethUtil.zeroAddress()

export default {

  // this links a CodexRecord record to a CodexRecordMetadata record based on
  //  the info emitted by the Minted event
  confirmMint: (tokenId, providerId, providerMetadataId, transactionHash) => {

    return models.CodexRecord.findById(tokenId)
      .then((codexRecord) => {

        if (!codexRecord) {
          throw new Error(`Could not confirm CodexRecord with tokenId ${tokenId} because it does not exist.`)
        }

        codexRecord.providerMetadataId = providerMetadataId
        codexRecord.providerId = providerId

        // TODO: sort out proper provider ID functionality
        if (codexRecord.providerId !== '1') {
          return codexRecord
        }

        return models.CodexRecordMetadata.findById(providerMetadataId)
          .then((codexRecordMetadata) => {

            if (!codexRecordMetadata) {
              throw new Error(`Could not confirm CodexRecord with tokenId ${codexRecord.tokenId} because metadata with id ${providerMetadataId} does not exit.`)
            }

            codexRecordMetadata.codexRecordTokenId = codexRecord.tokenId

            // TODO: maybe verify hases here? e.g.:
            // codexRecordMetadata.nameHash === codexRecord.nameHash
            // codexRecordMetadata.descriptionHash === codexRecord.descriptionHash

            return codexRecordMetadata.save()
              .then(() => {
                codexRecord.metadata = codexRecordMetadata
                return codexRecord
              })
          })
      })

      .then((codexRecord) => {
        return codexRecord.save()
      })

  },

  create: (ownerAddress, tokenId, transactionHash) => {

    return contracts.CodexRecord.methods.getTokenById(tokenId).call()
      .then(({ nameHash, descriptionHash, fileHashes }) => {

        const newCodexRecordProvenanceEventData = {
          newOwnerAddress: ownerAddress,
          oldOwnerAddress: zeroAddress,
          codexRecordTokenId: tokenId,
          transactionHash,
          type: 'create',
        }

        return new models.CodexRecordProvenanceEvent(newCodexRecordProvenanceEventData).save()
          .then((newCodexRecordProvenanceEvent) => {

            const newCodexRecordData = {
              provenance: [newCodexRecordProvenanceEvent],
              descriptionHash,
              ownerAddress,
              fileHashes,
              nameHash,
              tokenId,
            }

            return new models.CodexRecord(newCodexRecordData).save()

          })

      })

  },

  modify: (
    modifierAddress,
    tokenId,
    newNameHash,
    newDescriptionHash,
    newFileHashes,
    providerId,
    providerMetadataId,
    transactionHash,
  ) => {

    const findCodexRecordConditions = {
      providerId,
      _id: tokenId,
      providerMetadataId,
    }

    const newCodexRecordModifiedEvent = new models.CodexRecordModifiedEvent({
      newDescriptionHash,
      newFileHashes,
      newNameHash,

      oldDescriptionHash: null, // set below
      oldFileHashes: null, // set below
      oldNameHash: null, // set below

      providerMetadataId,
      modifierAddress,
      providerId,

    })

    return models.CodexRecord.findOne(findCodexRecordConditions)
      .populate('metadata')
      .then((codexRecord) => {

        if (!codexRecord) {
          throw new Error(`Could not modify CodexRecord with tokenId ${tokenId} because it does not exist.`)
        }

        newCodexRecordModifiedEvent.oldNameHash = codexRecord.nameHash
        newCodexRecordModifiedEvent.oldFileHashes = codexRecord.fileHashes
        newCodexRecordModifiedEvent.oldDescriptionHash = codexRecord.descriptionHash

        return newCodexRecordModifiedEvent.save()
          .then(() => {

            const newCodexRecordProvenanceEventData = {
              codexRecordTokenId: tokenId,
              type: 'modified',
              transactionHash,

              // these aren't really applicable to Modified events, so we'll just
              //  set them to the current ownerAddress ¯\_(ツ)_/¯
              oldOwnerAddress: codexRecord.ownerAddress,
              newOwnerAddress: codexRecord.ownerAddress,

              codexRecordModifiedEvent: newCodexRecordModifiedEvent,
            }

            return new models.CodexRecordProvenanceEvent(newCodexRecordProvenanceEventData).save()
              .then((newCodexRecordProvenanceEvent) => {

                codexRecord.nameHash = newNameHash
                codexRecord.fileHashes = newFileHashes
                codexRecord.descriptionHash = newDescriptionHash

                codexRecord.provenance.push(newCodexRecordProvenanceEvent)

                return codexRecord.save()

              })
          })
      })

      .then((codexRecord) => {

        // TODO: sort out proper provider ID functionality
        if (codexRecord.providerId !== '1') {
          return codexRecord
        }

        if (!codexRecord.metadata) {
          throw new Error(`Could not modify CodexRecord with tokenId ${codexRecord.tokenId} because metadata with id ${providerMetadataId} does not exit.`)
        }

        const pendingUpdateToCommitIndex = codexRecord.metadata.pendingUpdates.findIndex((pendingUpdate) => {

          if (
            newNameHash !== pendingUpdate.nameHash ||
            newDescriptionHash !== pendingUpdate.descriptionHash ||
            newFileHashes.length !== pendingUpdate.fileHashes.length
          ) {
            return false
          }

          // NOTE: pendingUpdate.fileHashes is already sorted as part of the
          //  virtual getter
          newFileHashes.sort()

          return pendingUpdate.fileHashes.every((fileHash, index) => {
            return fileHash === newFileHashes[index]
          })
        })

        if (pendingUpdateToCommitIndex === -1) {
          throw new Error(`Could not modify CodexRecord with tokenId ${codexRecord.tokenId} because metadata with id ${providerMetadataId} has no matching pending updates.`)
        }

        const [pendingUpdateToCommit] = codexRecord.metadata.pendingUpdates.splice(pendingUpdateToCommitIndex, 1)

        // TODO: maybe verify hases here? e.g.:
        // pendingUpdateToCommit.nameHash === nameHash
        // pendingUpdateToCommit.descriptionHash === descriptionHash

        newCodexRecordModifiedEvent.oldName = codexRecord.metadata.name
        newCodexRecordModifiedEvent.oldFiles = codexRecord.metadata.files
        newCodexRecordModifiedEvent.oldImages = codexRecord.metadata.images
        newCodexRecordModifiedEvent.oldMainImage = codexRecord.metadata.mainImage
        newCodexRecordModifiedEvent.oldDescription = codexRecord.metadata.description

        newCodexRecordModifiedEvent.newName = pendingUpdateToCommit.name
        newCodexRecordModifiedEvent.newFiles = pendingUpdateToCommit.files
        newCodexRecordModifiedEvent.newImages = pendingUpdateToCommit.images
        newCodexRecordModifiedEvent.newMainImage = pendingUpdateToCommit.mainImage
        newCodexRecordModifiedEvent.newDescription = pendingUpdateToCommit.description

        return newCodexRecordModifiedEvent.save()
          .then(() => {

            codexRecord.metadata.name = pendingUpdateToCommit.name
            codexRecord.metadata.files = pendingUpdateToCommit.files
            codexRecord.metadata.images = pendingUpdateToCommit.images
            codexRecord.metadata.nameHash = pendingUpdateToCommit.nameHash
            codexRecord.metadata.mainImage = pendingUpdateToCommit.mainImage
            codexRecord.metadata.description = pendingUpdateToCommit.description
            codexRecord.metadata.descriptionHash = pendingUpdateToCommit.descriptionHash

            return codexRecord.metadata.save()

          })
          .then(() => {
            return pendingUpdateToCommit.remove()
          })
      })

  },

  transfer: (oldOwnerAddress, newOwnerAddress, tokenId, transactionHash) => {

    return models.CodexRecord.findById(tokenId)
      .then((codexRecord) => {

        if (!codexRecord) {
          throw new Error(`Could not transfer CodexRecord with tokenId ${tokenId} because it does not exist.`)
        }

        const newCodexRecordProvenanceEventData = {
          codexRecordTokenId: tokenId,
          oldOwnerAddress,
          newOwnerAddress,
          transactionHash,
          type: 'transfer',
        }

        return new models.CodexRecordProvenanceEvent(newCodexRecordProvenanceEventData).save()
          .then((newCodexRecordProvenanceEvent) => {

            codexRecord.provenance.push(newCodexRecordProvenanceEvent)
            codexRecord.ownerAddress = newOwnerAddress
            codexRecord.whitelistedAddresses = []
            codexRecord.approvedAddress = null
            codexRecord.isIgnored = false
            codexRecord.isPrivate = true

            return codexRecord.save()

          })

      })

  },

  destroy: (ownerAddress, tokenId, transactionHash) => {

    return models.CodexRecord.findById(tokenId)
      .then((codexRecord) => {

        if (!codexRecord) {
          throw new Error(`Could not destroy CodexRecord with tokenId ${tokenId} because it does not exist.`)
        }

        const newCodexRecordProvenanceEventData = {
          oldOwnerAddress: ownerAddress,
          newOwnerAddress: zeroAddress,
          codexRecordTokenId: tokenId,
          transactionHash,
          type: 'destroy',
        }

        return new models.CodexRecordProvenanceEvent(newCodexRecordProvenanceEventData).save()
          .then((newCodexRecordProvenanceEvent) => {

            codexRecord.provenance.push(newCodexRecordProvenanceEvent)
            codexRecord.ownerAddress = zeroAddress

            return codexRecord.save()

          })

      })

  },

  approveAddress: (ownerAddress, approvedAddress, tokenId, transactionHash) => {

    return models.CodexRecord.findById(tokenId)
      .then((codexRecord) => {

        if (!codexRecord) {
          throw new Error(`Could not update approved address for CodexRecord with tokenId ${tokenId} because it does not exist.`)
        }

        codexRecord.approvedAddress = approvedAddress
        codexRecord.isIgnored = false

        return codexRecord.save()

      })

  },

  approveOperator: (ownerAddress, operatorAddress, isApproved, transactionHash) => {
    // TODO: implement approveOperator functionality here?
    logger.debug('codexRecordService.approveOperator() called', { ownerAddress, operatorAddress, isApproved })
  },

}