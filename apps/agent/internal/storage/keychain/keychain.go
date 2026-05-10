// SPDX-License-Identifier: Apache-2.0
package keychain

import "errors"

var ErrNotFound = errors.New("keychain: secret not found")

type Store interface {
	Set(key, value string) error
	Get(key string) (string, error)
	Delete(key string) error
}
