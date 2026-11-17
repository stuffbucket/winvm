const keeper = process.env.WINVM_KEEPER
if (process.env.WINVM_TEST_KEEPER === undefined && keeper !== undefined)
  process.env.WINVM_TEST_KEEPER = keeper
process.env.WINVM_KEEPER = "off"
